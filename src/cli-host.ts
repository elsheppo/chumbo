import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createInterface } from "node:readline/promises";
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import {
  KeychainOAuthProvider,
  SystemCredentialStore,
  type SecureCredentialStore,
} from "./cli-auth.js";
import {
  cliCapabilities,
  invocationNeedsConfirmation,
  parseCliInvocation,
  type CliCapability,
  type CliToolDescriptor,
} from "./cli-surface.js";

export interface BrandedCliConfig {
  readonly packageName: string;
  readonly binaryName: string;
  readonly displayName: string;
  readonly version: string;
  readonly endpoint: string;
  readonly supportUrl?: string;
  readonly poweredBy?: string;
  readonly callbackPort?: number;
}

export interface BrandedCliConnection {
  listTools(): Promise<{ tools: readonly CliToolDescriptor[] }>;
  callTool(input: {
    name: string;
    arguments: Readonly<Record<string, unknown>>;
  }): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface BrandedCliConnector {
  connect(interactive: boolean): Promise<BrandedCliConnection>;
  loggedInIssuer(): Promise<string | undefined>;
  logout(): Promise<void>;
}

export interface BrandedCliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly isTTY: boolean;
  readonly confirm: (prompt: string) => Promise<boolean>;
}

export interface BrandedCliDependencies {
  readonly connector?: BrandedCliConnector;
  readonly credentialStore?: SecureCredentialStore;
  readonly openAuthorization?: (url: URL) => void | Promise<void>;
  readonly io?: Partial<BrandedCliIo>;
}

export interface BrandedCli {
  run(argv?: readonly string[]): Promise<number>;
}

const binaryNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

function validateConfig(config: BrandedCliConfig): void {
  if (!config.packageName.trim())
    throw new TypeError("packageName is required");
  if (!binaryNamePattern.test(config.binaryName)) {
    throw new TypeError("binaryName must be lowercase kebab-case");
  }
  if (!config.displayName.trim())
    throw new TypeError("displayName is required");
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "127.0.0.1") {
    throw new TypeError("endpoint must use HTTPS outside loopback development");
  }
  if (config.supportUrl) new URL(config.supportUrl);
}

function defaultIo(): BrandedCliIo {
  return {
    stdout(value) {
      process.stdout.write(`${value}\n`);
    },
    stderr(value) {
      process.stderr.write(`${value}\n`);
    },
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async confirm(prompt) {
      const reader = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        const answer = await reader.question(`${prompt} [y/N] `);
        return /^(?:y|yes)$/iu.test(answer.trim());
      } finally {
        reader.close();
      }
    },
  };
}

function browserCommand(url: URL): { command: string; args: string[] } {
  if (process.platform === "darwin") {
    return { command: "open", args: [url.href] };
  }
  if (process.platform === "win32") {
    return { command: "explorer.exe", args: [url.href] };
  }
  return { command: "xdg-open", args: [url.href] };
}

function openBrowser(url: URL): Promise<void> {
  const { command, args } = browserCommand(url);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

interface CallbackListener {
  readonly redirectUrl: string;
  readonly wait: () => Promise<URLSearchParams>;
  readonly close: () => Promise<void>;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function callbackListener(port = 0): Promise<CallbackListener> {
  let resolveCallback!: (params: URLSearchParams) => void;
  let rejectCallback!: (error: Error) => void;
  const callback = new Promise<URLSearchParams>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/oauth/callback") {
        response.writeHead(404).end("Not found");
        return;
      }
      response
        .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
        .end("Sign-in complete. You can return to your terminal.");
      resolveCallback(url.searchParams);
    } catch (error) {
      response.writeHead(400).end("Invalid authorization callback");
      rejectCallback(
        error instanceof Error ? error : new Error("Invalid callback"),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Could not reserve a loopback OAuth callback port");
  }
  return {
    redirectUrl: `http://127.0.0.1:${address.port}/oauth/callback`,
    async wait() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          callback,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Timed out waiting for browser sign-in")),
              120_000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        await closeServer(server);
      }
    },
    close: () => closeServer(server),
  };
}

function asConnection(client: Client): BrandedCliConnection {
  return {
    async listTools() {
      const result = await client.listTools();
      return { tools: result.tools as readonly CliToolDescriptor[] };
    },
    callTool(input) {
      return client.callTool(input);
    },
    close() {
      return client.close();
    },
  };
}

function systemConnector(
  config: BrandedCliConfig,
  store: SecureCredentialStore,
  authorize: (url: URL) => void | Promise<void>,
): BrandedCliConnector {
  let statusProvider: KeychainOAuthProvider | undefined;
  const callbackPort = config.callbackPort ?? 47832;
  const redirectUrl = `http://127.0.0.1:${callbackPort}/oauth/callback`;

  async function provider(
    redirectUrl: string,
    interactive: boolean,
  ): Promise<KeychainOAuthProvider> {
    const created = new KeychainOAuthProvider({
      endpoint: config.endpoint,
      redirectUrl,
      displayName: config.displayName,
      version: config.version,
      store,
      openAuthorization: interactive ? authorize : () => {},
    });
    statusProvider = created;
    return created;
  }

  function clientTransport(auth: KeychainOAuthProvider): {
    client: Client;
    transport: StreamableHTTPClientTransport;
  } {
    const transport = new StreamableHTTPClientTransport(
      new URL(config.endpoint),
      { authProvider: auth },
    );
    const client = new Client({
      name: `${config.packageName}-cli`,
      version: config.version,
    });
    return { client, transport };
  }

  return {
    async connect(interactive) {
      const listener = interactive
        ? await callbackListener(callbackPort)
        : undefined;
      const auth = await provider(
        listener?.redirectUrl ?? redirectUrl,
        interactive,
      );
      const attempted = clientTransport(auth);
      try {
        await attempted.client.connect(attempted.transport);
        await listener?.close();
        return asConnection(attempted.client);
      } catch (error) {
        if (!(error instanceof UnauthorizedError) || !listener) {
          await listener?.close();
          throw error;
        }
        const params = await listener.wait();
        const expectedState = await auth.expectedState();
        if (!expectedState || params.get("state") !== expectedState) {
          throw new Error("OAuth callback state did not match; restart login");
        }
        await attempted.transport.finishAuth(params);
        const connected = clientTransport(auth);
        await connected.client.connect(connected.transport);
        return asConnection(connected.client);
      }
    },
    async loggedInIssuer() {
      const auth = statusProvider ?? (await provider(redirectUrl, false));
      return auth.loggedInIssuer();
    },
    async logout() {
      const auth = statusProvider ?? (await provider(redirectUrl, false));
      await auth.invalidateCredentials("all");
    },
  };
}

function rootHelp(config: BrandedCliConfig): string {
  const attribution = config.poweredBy
    ? `\nPowered by ${config.poweredBy}.`
    : "";
  const support = config.supportUrl ? `\nSupport: ${config.supportUrl}` : "";
  return `${config.displayName} CLI\n\nUsage:\n  ${config.binaryName} login\n  ${config.binaryName} status\n  ${config.binaryName} commands\n  ${config.binaryName} <command> [options]\n  ${config.binaryName} logout\n\nRun '${config.binaryName} commands' after signing in to see what you can do.${attribution}${support}`;
}

function capabilityHelp(config: BrandedCliConfig, item: CliCapability): string {
  const root = item.inputSchema as Record<string, unknown>;
  const properties =
    typeof root.properties === "object" && root.properties !== null
      ? (root.properties as Record<string, unknown>)
      : {};
  const required = new Set(
    Array.isArray(root.required)
      ? root.required.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  );
  const options = Object.entries(properties).map(([name, schema]) => {
    const shape = schema as Record<string, unknown>;
    const flag = name
      .replaceAll("_", "-")
      .replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
    return `  --${flag}${shape.type === "boolean" ? " <true|false>" : " <value>"}${required.has(name) ? "  required" : ""}`;
  });
  const examples = item.examples.map(
    (example) => `  ${config.binaryName} ${example}`,
  );
  return `${item.title}\n${item.description}\n\nUsage:\n  ${config.binaryName} ${item.command.join(" ")} [options]${options.length ? `\n\nOptions:\n${options.join("\n")}` : ""}${item.risk === "read" ? "" : "\n  --yes  confirm this change"}\n  --json  emit a stable JSON receipt${examples.length ? `\n\nExamples:\n${examples.join("\n")}` : ""}`;
}

function commandList(
  config: BrandedCliConfig,
  items: readonly CliCapability[],
): string {
  const lines = items.map(
    (item) =>
      `  ${config.binaryName} ${item.command.join(" ")}${item.description ? `\n      ${item.description}` : ""}`,
  );
  return `${config.displayName} commands available to this signed-in user:\n\n${lines.join("\n")}`;
}

function humanResult(result: CallToolResult): string {
  const text = result.content
    .filter(
      (
        block,
      ): block is Extract<(typeof result.content)[number], { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (text) return text;
  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent, null, 2);
  }
  return result.isError ? "The command failed." : "Done.";
}

function errorMessage(error: unknown): string {
  if (error instanceof UnauthorizedError) return "Sign in required.";
  return error instanceof Error ? error.message : "Unknown CLI error";
}

export function createBrandedCli(
  config: BrandedCliConfig,
  dependencies: BrandedCliDependencies = {},
): BrandedCli {
  validateConfig(config);
  const base = defaultIo();
  const io: BrandedCliIo = { ...base, ...dependencies.io };
  const store =
    dependencies.credentialStore ??
    new SystemCredentialStore(`dev.chumbo.cloud.cli:${config.packageName}`);
  const connector =
    dependencies.connector ??
    systemConnector(
      config,
      store,
      dependencies.openAuthorization ??
        ((url) => {
          io.stderr(
            `Open this sign-in URL if your browser does not open:\n${url.href}`,
          );
          return openBrowser(url);
        }),
    );

  return {
    async run(argv = process.argv.slice(2)): Promise<number> {
      const args = [...argv];
      const jsonRequested = args.includes("--json");
      try {
        if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
          io.stdout(rootHelp(config));
          return 0;
        }
        if (args[0] === "login") {
          const connection = await connector.connect(true);
          const { tools } = await connection.listTools();
          await connection.close();
          const issuer = await connector.loggedInIssuer();
          const receipt = {
            ok: true,
            action: "login",
            issuer,
            commands: cliCapabilities(tools).length,
          };
          io.stdout(
            jsonRequested
              ? JSON.stringify(receipt)
              : `Signed in to ${config.displayName}. ${receipt.commands} commands available.`,
          );
          return 0;
        }
        if (args[0] === "logout") {
          await connector.logout();
          io.stdout(
            jsonRequested
              ? JSON.stringify({ ok: true, action: "logout" })
              : `Signed out of ${config.displayName}.`,
          );
          return 0;
        }
        if (args[0] === "status") {
          const issuer = await connector.loggedInIssuer();
          if (!issuer) {
            const receipt = { ok: false, signedIn: false };
            io.stdout(
              jsonRequested
                ? JSON.stringify(receipt)
                : `Not signed in. Run '${config.binaryName} login'.`,
            );
            return 3;
          }
          try {
            const connection = await connector.connect(false);
            await connection.listTools();
            await connection.close();
          } catch (error) {
            if (!(error instanceof UnauthorizedError)) throw error;
            const receipt = { ok: false, signedIn: false };
            io.stdout(
              jsonRequested
                ? JSON.stringify(receipt)
                : `Session expired. Run '${config.binaryName} login'.`,
            );
            return 3;
          }
          const receipt = { ok: true, signedIn: true, issuer };
          io.stdout(
            jsonRequested
              ? JSON.stringify(receipt)
              : `Signed in to ${config.displayName}.`,
          );
          return 0;
        }

        const connection = await connector.connect(false);
        try {
          const listed = await connection.listTools();
          const capabilities = cliCapabilities(listed.tools);
          if (args[0] === "commands") {
            io.stdout(
              jsonRequested
                ? JSON.stringify({
                    ok: true,
                    commands: capabilities.map((item) => ({
                      command: item.command,
                      description: item.description,
                      risk: item.risk,
                    })),
                  })
                : commandList(config, capabilities),
            );
            return 0;
          }
          const wantsHelp = args.at(-1) === "--help";
          const invocation = parseCliInvocation(
            capabilities,
            wantsHelp ? args.slice(0, -1) : args,
          );
          if (wantsHelp) {
            io.stdout(capabilityHelp(config, invocation.capability));
            return 0;
          }
          if (invocationNeedsConfirmation(invocation)) {
            if (!io.isTTY) {
              io.stderr(
                `Refusing a ${invocation.capability.risk} command without --yes in a non-interactive session.`,
              );
              return 4;
            }
            const confirmed = await io.confirm(
              `Run ${config.binaryName} ${invocation.capability.command.join(" ")}?`,
            );
            if (!confirmed) {
              io.stderr("Command cancelled.");
              return 4;
            }
          }
          const result = await connection.callTool({
            name: invocation.capability.mcpName,
            arguments: invocation.arguments,
          });
          if (invocation.json) {
            io.stdout(
              JSON.stringify({
                ok: !result.isError,
                command: invocation.capability.command,
                capabilityId: invocation.capability.id,
                mcpName: invocation.capability.mcpName,
                result,
              }),
            );
          } else {
            io.stdout(
              invocation.capability.presentation === "json" &&
                result.structuredContent !== undefined
                ? JSON.stringify(result.structuredContent, null, 2)
                : humanResult(result),
            );
          }
          return result.isError ? 1 : 0;
        } finally {
          await connection.close();
        }
      } catch (error) {
        const auth = error instanceof UnauthorizedError;
        const message = auth
          ? `Sign in required. Run '${config.binaryName} login'.`
          : errorMessage(error);
        if (jsonRequested) {
          io.stdout(
            JSON.stringify({
              ok: false,
              error: { code: auth ? "AUTH_REQUIRED" : "CLI_ERROR", message },
            }),
          );
        } else {
          io.stderr(message);
        }
        return auth ? 3 : 2;
      }
    },
  };
}

export async function runBrandedCli(
  config: BrandedCliConfig,
  dependencies?: BrandedCliDependencies,
): Promise<never> {
  const code = await createBrandedCli(config, dependencies).run();
  process.exit(code);
}

export {
  KeychainOAuthProvider,
  SystemCredentialStore,
  type SecureCredentialStore,
} from "./cli-auth.js";
