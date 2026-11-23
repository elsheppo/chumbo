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
  StaticTokenCredentialStore,
  SystemCredentialStore,
  type SecureCredentialStore,
} from "./cli-auth.js";
import {
  COMPLETION_SHELLS,
  renderShellCompletions,
  type CompletionShell,
} from "./cli-completions.js";
import { runCustomerSkillCommand } from "./cli-customer-skill.js";
import {
  FileDiscoveryCache,
  type BrandedCliDiscoveryCache,
  type DiscoveryCachePartitionInput,
} from "./cli-discovery-cache.js";
import {
  cliCapabilityForCommand,
  cliCapabilities,
  invocationNeedsConfirmation,
  parseCliInvocation,
  type CliCapability,
  type CliToolDescriptor,
} from "./cli-surface.js";
import { RESERVED_CLI_ROOT_COMMANDS } from "./types.js";

export type BrandedCliAuthMode = "oauth" | "token" | "public" | "auto";

export interface BrandedCliAuthConfig {
  readonly mode?: BrandedCliAuthMode;
  readonly tokenEnvVar?: string;
  readonly headerName?: string;
}

export interface BrandedCliDiscoveryCacheConfig {
  readonly ttlMs?: number;
}

export interface BrandedCliConfig {
  readonly packageName: string;
  readonly binaryName: string;
  readonly displayName: string;
  readonly version: string;
  readonly endpoint: string;
  readonly supportUrl?: string;
  readonly poweredBy?: string;
  readonly callbackPort?: number;
  readonly auth?: BrandedCliAuthConfig;
  readonly discoveryCache?: BrandedCliDiscoveryCacheConfig;
}

export interface BrandedCliConnection {
  listTools(): Promise<{ tools: readonly CliToolDescriptor[] }>;
  callTool(input: {
    name: string;
    arguments: Readonly<Record<string, unknown>>;
  }): Promise<CallToolResult>;
  close(): Promise<void>;
}

export type ActiveCredentialSource =
  | {
      readonly kind: "flag-stdin" | "flag-token" | "env";
      readonly envVar?: string;
    }
  | { readonly kind: "keychain-token" }
  | { readonly kind: "keychain-oauth"; readonly issuer: string }
  | { readonly kind: "public" };

export interface ActiveCredentialDescriptor {
  readonly source: ActiveCredentialSource;
  readonly partitionMaterial: string;
}

export interface BrandedCliConnector {
  connect(interactive: boolean): Promise<BrandedCliConnection>;
  loggedInIssuer(): Promise<string | undefined>;
  logout(): Promise<void>;
  saveStaticToken?(token: string): Promise<void>;
  activeCredential?(
    overrideToken?: string,
    overrideSource?: "flag-stdin" | "flag-token",
  ): Promise<ActiveCredentialDescriptor | undefined>;
  connectWithToken?(token: string): Promise<BrandedCliConnection>;
}

export interface BrandedCliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly isTTY: boolean;
  readonly stdinIsTTY?: boolean;
  readonly readStdin?: () => Promise<string>;
  readonly confirm: (prompt: string) => Promise<boolean>;
}

export interface BrandedCliDependencies {
  readonly connector?: BrandedCliConnector;
  readonly credentialStore?: SecureCredentialStore;
  readonly discoveryCache?: BrandedCliDiscoveryCache | false;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly openAuthorization?: (url: URL) => void | Promise<void>;
  readonly io?: Partial<BrandedCliIo>;
}

export interface BrandedCli {
  run(argv?: readonly string[]): Promise<number>;
}

const binaryNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const envVarNamePattern = /^[A-Z][A-Z0-9_]{1,63}$/u;
const httpHeaderNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/u;
const MAX_TOKEN_BYTES = 8_192;
const reservedRootSet = new Set<string>(RESERVED_CLI_ROOT_COMMANDS);

export function defaultTokenEnvVar(binaryName: string): string {
  return `${binaryName.replaceAll("-", "_").toUpperCase()}_TOKEN`;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]"
  );
}

function validateConfig(config: BrandedCliConfig): void {
  if (!config.packageName.trim())
    throw new TypeError("packageName is required");
  if (!binaryNamePattern.test(config.binaryName)) {
    throw new TypeError("binaryName must be lowercase kebab-case");
  }
  if (!config.displayName.trim())
    throw new TypeError("displayName is required");
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== "https:" && !isLoopbackHost(endpoint.hostname)) {
    throw new TypeError("endpoint must use HTTPS outside loopback development");
  }
  if (config.supportUrl) new URL(config.supportUrl);
  if (config.auth) {
    if (
      config.auth.mode !== undefined &&
      !["oauth", "token", "public", "auto"].includes(config.auth.mode)
    ) {
      throw new TypeError(
        "auth.mode must be one of: oauth, token, public, auto",
      );
    }
    if (
      config.auth.tokenEnvVar !== undefined &&
      !envVarNamePattern.test(config.auth.tokenEnvVar)
    ) {
      throw new TypeError(
        "auth.tokenEnvVar must be an uppercase POSIX environment variable name",
      );
    }
    if (
      config.auth.headerName !== undefined &&
      !httpHeaderNamePattern.test(config.auth.headerName)
    ) {
      throw new TypeError("auth.headerName must be a valid HTTP header token");
    }
  }
  if (
    config.discoveryCache?.ttlMs !== undefined &&
    (!Number.isFinite(config.discoveryCache.ttlMs) ||
      config.discoveryCache.ttlMs < 0)
  ) {
    throw new TypeError("discoveryCache.ttlMs must be a non-negative number");
  }
}

function validateSecretToken(raw: string, sourceLabel: string): string {
  const trimmed = raw.replace(/\r?\n$/u, "");
  if (!trimmed) {
    throw new TypeError(`${sourceLabel} cannot be empty`);
  }
  if (Buffer.byteLength(trimmed, "utf8") > MAX_TOKEN_BYTES) {
    throw new TypeError(`${sourceLabel} exceeds maximum length`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new TypeError(
      `${sourceLabel} must not contain control characters or multiple lines`,
    );
  }
  return trimmed;
}

function readAllProcessStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer | string) => {
      const buf =
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      total += buf.byteLength;
      if (total > MAX_TOKEN_BYTES * 2) {
        cleanup();
        reject(new TypeError("--token-stdin input exceeds maximum length"));
        return;
      }
      chunks.push(buf);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
    };
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);
  });
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
    stdinIsTTY: Boolean(process.stdin.isTTY),
    readStdin: readAllProcessStdin,
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

export function createStaticTokenTransport(
  endpoint: URL,
  token: string,
  headerName = "Authorization",
): StreamableHTTPClientTransport {
  if (headerName.toLowerCase() === "authorization") {
    return new StreamableHTTPClientTransport(endpoint, {
      authProvider: { token: async () => token },
      onInsufficientScope: "throw",
    });
  }
  return new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { [headerName]: token } },
    onInsufficientScope: "throw",
  });
}

function systemConnector(
  config: BrandedCliConfig,
  store: SecureCredentialStore,
  authorize: (url: URL) => void | Promise<void>,
  env: Readonly<Record<string, string | undefined>>,
  getOverrideToken: () => {
    readonly token?: string;
    readonly source?: "flag-stdin" | "flag-token";
  },
): BrandedCliConnector {
  let statusProvider: KeychainOAuthProvider | undefined;
  const callbackPort = config.callbackPort ?? 47832;
  const redirectUrl = `http://127.0.0.1:${callbackPort}/oauth/callback`;
  const authMode = config.auth?.mode ?? "oauth";
  const tokenEnvVar =
    config.auth?.tokenEnvVar ?? defaultTokenEnvVar(config.binaryName);
  const headerName = config.auth?.headerName ?? "Authorization";
  const staticStore = new StaticTokenCredentialStore(store, config.endpoint);

  async function provider(
    targetRedirectUrl: string,
    interactive: boolean,
  ): Promise<KeychainOAuthProvider> {
    const created = new KeychainOAuthProvider({
      endpoint: config.endpoint,
      redirectUrl: targetRedirectUrl,
      displayName: config.displayName,
      version: config.version,
      store,
      openAuthorization: interactive ? authorize : () => {},
    });
    statusProvider = created;
    return created;
  }

  function oauthClientTransport(auth: KeychainOAuthProvider): {
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

  async function connectStatic(token: string): Promise<BrandedCliConnection> {
    const transport = createStaticTokenTransport(
      new URL(config.endpoint),
      token,
      headerName,
    );
    const client = new Client({
      name: `${config.packageName}-cli`,
      version: config.version,
    });
    await client.connect(transport);
    return asConnection(client);
  }

  async function connectAnonymous(): Promise<BrandedCliConnection> {
    const transport = new StreamableHTTPClientTransport(
      new URL(config.endpoint),
    );
    const client = new Client({
      name: `${config.packageName}-cli`,
      version: config.version,
    });
    await client.connect(transport);
    return asConnection(client);
  }

  function resolveHeadlessToken(
    explicitToken?: string,
    explicitSource?: "flag-stdin" | "flag-token",
  ):
    | {
        readonly token: string;
        readonly source: ActiveCredentialSource;
      }
    | undefined {
    const active = explicitToken
      ? { token: explicitToken, source: explicitSource ?? "flag-token" }
      : getOverrideToken();
    if (active.token) {
      return {
        token: active.token,
        source: { kind: active.source ?? "flag-token" },
      };
    }
    const envRaw = env[tokenEnvVar];
    if (envRaw && envRaw.trim().length > 0) {
      const validated = validateSecretToken(envRaw.trim(), tokenEnvVar);
      return {
        token: validated,
        source: { kind: "env", envVar: tokenEnvVar },
      };
    }
    return undefined;
  }

  return {
    async connectWithToken(token) {
      return connectStatic(token);
    },

    async saveStaticToken(token) {
      await staticStore.set(token);
    },

    async activeCredential(overrideToken, overrideSource) {
      const headless = resolveHeadlessToken(overrideToken, overrideSource);
      if (headless) {
        return {
          source: headless.source,
          partitionMaterial: headless.token,
        };
      }
      if (authMode === "public") {
        return {
          source: { kind: "public" },
          partitionMaterial: "anonymous",
        };
      }
      if (authMode === "token") {
        const stored = await staticStore.get();
        return stored
          ? { source: { kind: "keychain-token" }, partitionMaterial: stored }
          : undefined;
      }
      if (authMode === "auto") {
        const stored = await staticStore.get();
        if (stored) {
          return {
            source: { kind: "keychain-token" },
            partitionMaterial: stored,
          };
        }
      }
      const auth = statusProvider ?? (await provider(redirectUrl, false));
      const issuer = await auth.loggedInIssuer();
      if (!issuer) return undefined;
      const tokens = await auth.tokens({ issuer });
      if (!tokens?.access_token) return undefined;
      return {
        source: { kind: "keychain-oauth", issuer },
        partitionMaterial: `${issuer}\u0000${tokens.access_token}`,
      };
    },

    async connect(interactive) {
      if (!interactive) {
        const headless = resolveHeadlessToken();
        if (headless) {
          return connectStatic(headless.token);
        }
        if (authMode === "public") {
          return connectAnonymous();
        }
        if (authMode === "token") {
          const stored = await staticStore.get();
          if (!stored) {
            throw new UnauthorizedError("Token authentication required");
          }
          return connectStatic(stored);
        }
        if (authMode === "auto") {
          const stored = await staticStore.get();
          if (stored) {
            return connectStatic(stored);
          }
        }
      }

      const listener = interactive
        ? await callbackListener(callbackPort)
        : undefined;
      const auth = await provider(
        listener?.redirectUrl ?? redirectUrl,
        interactive,
      );
      if (interactive) {
        await auth.invalidateCredentials("discovery");
      }
      const attempted = oauthClientTransport(auth);
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
        const connected = oauthClientTransport(auth);
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
      await staticStore.delete();
    },
  };
}

function safeCliCapabilities(
  tools: readonly CliToolDescriptor[],
): readonly CliCapability[] {
  // Guard against unvalidated remote manifests shadowing built-in host commands
  const sanitizedTools = tools.map((tool): CliToolDescriptor => {
    const meta = tool._meta;
    if (!meta || typeof meta !== "object") return tool;
    const rawCap = meta["dev.chumbo/capability"];
    if (!rawCap || typeof rawCap !== "object" || Array.isArray(rawCap)) {
      return tool;
    }
    const rawCli = (rawCap as { cli?: unknown }).cli;
    if (!rawCli || typeof rawCli !== "object" || Array.isArray(rawCli)) {
      return tool;
    }
    const command = (rawCli as { command?: unknown }).command;
    if (
      Array.isArray(command) &&
      typeof command[0] === "string" &&
      reservedRootSet.has(command[0])
    ) {
      return {
        ...tool,
        _meta: {
          ...meta,
          "dev.chumbo/capability": {
            ...(rawCap as Record<string, unknown>),
            cli: {
              ...(rawCli as Record<string, unknown>),
              command: ["run", ...command],
            },
          },
        },
      };
    }
    return tool;
  });
  return cliCapabilities(sanitizedTools);
}

function rootHelp(config: BrandedCliConfig, tokenEnvVar: string): string {
  const attribution = config.poweredBy
    ? `\nPowered by ${config.poweredBy}.`
    : "";
  const support = config.supportUrl ? `\nSupport: ${config.supportUrl}` : "";
  const authHint =
    config.auth?.mode === "token"
      ? `\nHeadless auth: set ${tokenEnvVar} or pipe to '${config.binaryName} login --token-stdin'.`
      : `\nHeadless auth: set ${tokenEnvVar} for non-interactive CI and agent sessions.`;
  return `${config.displayName} CLI\n\nUsage:\n  ${config.binaryName} login [--token-stdin]\n  ${config.binaryName} status\n  ${config.binaryName} commands [--refresh]\n  ${config.binaryName} <command> [options]\n  ${config.binaryName} skill <install|status|update> [options]\n  ${config.binaryName} completions <zsh|bash|fish>\n  ${config.binaryName} logout\n\nRun '${config.binaryName} commands' after signing in to see what you can do.${authHint}${attribution}${support}`;
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

function errorMessage(
  error: unknown,
  secretsToScrub: readonly string[],
): string {
  if (error instanceof UnauthorizedError) return "Sign in required.";
  let raw = error instanceof Error ? error.message : "Unknown CLI error";
  for (const secret of secretsToScrub) {
    if (secret) raw = raw.replaceAll(secret, "[REDACTED]");
  }
  return raw;
}

interface ExtractedHostFlags {
  readonly cleanArgs: string[];
  readonly refresh: boolean;
  readonly tokenStdin: boolean;
  readonly inlineToken?: string;
}

function extractHostFlags(argv: readonly string[]): ExtractedHostFlags {
  const cleanArgs: string[] = [];
  let refresh = false;
  let tokenStdin = false;
  let inlineToken: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--refresh") {
      refresh = true;
      continue;
    }
    if (arg === "--token-stdin") {
      tokenStdin = true;
      continue;
    }
    if (arg === "--token") {
      const next = argv[++i];
      if (next === undefined) {
        throw new TypeError("--token requires a credential value");
      }
      inlineToken = validateSecretToken(next, "--token");
      continue;
    }
    cleanArgs.push(arg);
  }

  if (tokenStdin && inlineToken !== undefined) {
    throw new TypeError("Pass either --token or --token-stdin, not both");
  }

  return { cleanArgs, refresh, tokenStdin, inlineToken };
}

function isUnknownCommandOrOptionError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    (error.message === "Unknown command" ||
      error.message.startsWith("Unknown option:"))
  );
}

export function createBrandedCli(
  config: BrandedCliConfig,
  dependencies: BrandedCliDependencies = {},
): BrandedCli {
  validateConfig(config);
  const base = defaultIo();
  const io: BrandedCliIo = { ...base, ...dependencies.io };
  const env = dependencies.env ?? process.env;
  const cwd = dependencies.cwd ?? process.cwd();
  const authMode = config.auth?.mode ?? "oauth";
  const tokenEnvVar =
    config.auth?.tokenEnvVar ?? defaultTokenEnvVar(config.binaryName);
  const headerName = config.auth?.headerName ?? "Authorization";

  let currentOverride: {
    token?: string;
    source?: "flag-stdin" | "flag-token";
  } = {};

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
      env,
      () => currentOverride,
    );

  // Default disk discovery cache only when neither connector nor credentialStore
  // is overridden in tests, or when discoveryCache is explicitly injected.
  const cacheTtlMs = config.discoveryCache?.ttlMs;
  const discoveryCache: BrandedCliDiscoveryCache | undefined =
    dependencies.discoveryCache === false || cacheTtlMs === 0
      ? undefined
      : dependencies.discoveryCache !== undefined
        ? dependencies.discoveryCache
        : !dependencies.connector && !dependencies.credentialStore
          ? new FileDiscoveryCache(
              cacheTtlMs !== undefined ? { defaultTtlMs: cacheTtlMs } : {},
            )
          : undefined;

  async function resolveCachePartition(): Promise<
    DiscoveryCachePartitionInput | undefined
  > {
    if (!discoveryCache) return undefined;
    if (connector.activeCredential) {
      const cred = await connector.activeCredential(
        currentOverride.token,
        currentOverride.source,
      );
      if (!cred) return undefined;
      const credentialKind =
        cred.source.kind === "public"
          ? "public"
          : cred.source.kind === "keychain-oauth"
            ? "oauth"
            : "static";
      return {
        endpoint: config.endpoint,
        credentialKind,
        headerName,
        credentialMaterial: cred.partitionMaterial,
      };
    }
    const issuer = await connector.loggedInIssuer();
    if (!issuer) return undefined;
    return {
      endpoint: config.endpoint,
      credentialKind: "oauth",
      headerName,
      credentialMaterial: issuer,
    };
  }

  async function writeCachePostConnect(
    tools: readonly CliToolDescriptor[],
  ): Promise<void> {
    if (!discoveryCache) return;
    const refreshedPartition = await resolveCachePartition();
    if (!refreshedPartition) return;
    await discoveryCache.write(refreshedPartition, tools, cacheTtlMs);
  }

  return {
    async run(argv = process.argv.slice(2)): Promise<number> {
      const jsonRequested = argv.includes("--json");
      const secretsToScrub: string[] = [];
      currentOverride = {};

      try {
        const extracted = extractHostFlags(argv);
        const args = extracted.cleanArgs;

        if (extracted.inlineToken !== undefined) {
          secretsToScrub.push(extracted.inlineToken);
          currentOverride = {
            token: extracted.inlineToken,
            source: "flag-token",
          };
          if (io.isTTY && !jsonRequested) {
            io.stderr(
              `Tip: Prefer ${tokenEnvVar} or --token-stdin to keep credentials out of process arguments.`,
            );
          }
        }

        if (extracted.tokenStdin && args[0] !== "login") {
          const stdinIsTty = io.stdinIsTTY ?? io.isTTY;
          if (stdinIsTty) {
            throw new TypeError(
              `Pipe a credential to stdin when using --token-stdin, or set ${tokenEnvVar}.`,
            );
          }
          if (!io.readStdin) {
            throw new TypeError("Standard input reader is unavailable");
          }
          const token = validateSecretToken(
            await io.readStdin(),
            "--token-stdin",
          );
          secretsToScrub.push(token);
          currentOverride = { token, source: "flag-stdin" };
        }

        const envSecret = env[tokenEnvVar]?.trim();
        if (envSecret) secretsToScrub.push(envSecret);

        if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
          io.stdout(rootHelp(config, tokenEnvVar));
          return 0;
        }

        if (args[0] === "login") {
          if (extracted.tokenStdin) {
            if (!io.readStdin) {
              throw new TypeError("Standard input reader is unavailable");
            }
            const token = validateSecretToken(
              await io.readStdin(),
              "--token-stdin",
            );
            secretsToScrub.push(token);
            currentOverride = { token, source: "flag-stdin" };
            const connection = connector.connectWithToken
              ? await connector.connectWithToken(token)
              : await connector.connect(false);
            let tools: readonly CliToolDescriptor[];
            try {
              tools = (await connection.listTools()).tools;
            } finally {
              await connection.close();
            }
            await connector.saveStaticToken?.(token);
            currentOverride = {};
            await writeCachePostConnect(tools);
            const receipt = {
              ok: true,
              action: "login",
              authSource: "keychain-token" as const,
              commands: safeCliCapabilities(tools).length,
            };
            io.stdout(
              jsonRequested
                ? JSON.stringify(receipt)
                : `Signed in to ${config.displayName}. ${receipt.commands} commands available.`,
            );
            return 0;
          }

          if (authMode === "token") {
            throw new TypeError(
              `${config.displayName} uses token authentication. Set ${tokenEnvVar} or pipe a credential to '${config.binaryName} login --token-stdin'.`,
            );
          }

          if (
            !io.isTTY &&
            !dependencies.openAuthorization &&
            !dependencies.connector
          ) {
            const msg = `Interactive browser sign-in requires a terminal. Set ${tokenEnvVar} or pipe a credential to '${config.binaryName} login --token-stdin'.`;
            if (jsonRequested) {
              io.stdout(
                JSON.stringify({
                  ok: false,
                  error: { code: "AUTH_REQUIRED", message: msg },
                }),
              );
            } else {
              io.stderr(msg);
            }
            return 3;
          }

          const connection = await connector.connect(true);
          let tools: readonly CliToolDescriptor[];
          try {
            tools = (await connection.listTools()).tools;
          } finally {
            await connection.close();
          }
          await writeCachePostConnect(tools);
          const issuer = await connector.loggedInIssuer();
          const receipt = {
            ok: true,
            action: "login",
            issuer,
            commands: safeCliCapabilities(tools).length,
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
          await discoveryCache?.purgeAll();
          io.stdout(
            jsonRequested
              ? JSON.stringify({ ok: true, action: "logout" })
              : `Signed out of ${config.displayName}.`,
          );
          return 0;
        }

        if (args[0] === "status") {
          const prePartition = await resolveCachePartition();
          const cred = connector.activeCredential
            ? await connector.activeCredential(
                currentOverride.token,
                currentOverride.source,
              )
            : undefined;
          const issuer = !cred ? await connector.loggedInIssuer() : undefined;

          if (!cred && !issuer && authMode !== "public") {
            const receipt = { ok: false, signedIn: false };
            io.stdout(
              jsonRequested
                ? JSON.stringify(receipt)
                : authMode === "token"
                  ? `Not authenticated. Set ${tokenEnvVar} or run '${config.binaryName} login --token-stdin'.`
                  : `Not signed in. Run '${config.binaryName} login'.`,
            );
            return 3;
          }

          try {
            const connection = await connector.connect(false);
            let tools: readonly CliToolDescriptor[];
            try {
              tools = (await connection.listTools()).tools;
            } finally {
              await connection.close();
            }
            await writeCachePostConnect(tools);
          } catch (error) {
            if (!(error instanceof UnauthorizedError)) throw error;
            if (prePartition) {
              await discoveryCache?.invalidate(prePartition);
            }
            const receipt = { ok: false, signedIn: false };
            io.stdout(
              jsonRequested
                ? JSON.stringify(receipt)
                : `Session expired. Run '${config.binaryName} login'.`,
            );
            return 3;
          }

          const resolvedIssuer =
            cred?.source.kind === "keychain-oauth"
              ? cred.source.issuer
              : issuer;
          const authSource = cred
            ? cred.source.kind === "keychain-oauth"
              ? "oauth"
              : cred.source.kind === "flag-stdin" ||
                  cred.source.kind === "flag-token"
                ? "flag"
                : cred.source.kind
            : "oauth";
          const receipt = {
            ok: true,
            signedIn: true,
            authSource,
            ...(resolvedIssuer ? { issuer: resolvedIssuer } : {}),
          };
          io.stdout(
            jsonRequested
              ? JSON.stringify(receipt)
              : `Signed in to ${config.displayName}.`,
          );
          return 0;
        }

        // Helper for discovery-only subcommands (`commands`, `skill`, `completions`)
        const loadCapabilities = async (
          forceRefresh: boolean,
        ): Promise<readonly CliCapability[]> => {
          const partition = await resolveCachePartition();
          if (!forceRefresh && partition && discoveryCache) {
            const cached = await discoveryCache.read(partition);
            if (cached) return safeCliCapabilities(cached);
          }
          const connection = await connector.connect(false);
          try {
            const listed = await connection.listTools();
            await writeCachePostConnect(listed.tools);
            return safeCliCapabilities(listed.tools);
          } finally {
            await connection.close();
          }
        };

        if (args[0] === "completions") {
          const compArgs = args.slice(1);
          const offline = compArgs.includes("--offline");
          const positional = compArgs.filter((a) => !a.startsWith("-"));
          const unknownFlags = compArgs.filter(
            (a) => a.startsWith("-") && a !== "--offline" && a !== "--help",
          );
          if (compArgs.includes("--help")) {
            io.stdout(
              `Usage:\n  ${config.binaryName} completions <zsh|bash|fish> [--refresh] [--offline]`,
            );
            return 0;
          }
          if (unknownFlags.length > 0) {
            throw new TypeError(
              `Unknown completions option: ${unknownFlags[0]}`,
            );
          }
          const shell = positional[0] as CompletionShell | undefined;
          if (
            !shell ||
            positional.length > 1 ||
            !COMPLETION_SHELLS.includes(shell)
          ) {
            throw new TypeError(
              `Usage: ${config.binaryName} completions <zsh|bash|fish>`,
            );
          }
          let capabilities: readonly CliCapability[] = [];
          if (offline) {
            const partition = await resolveCachePartition();
            const cached =
              partition && discoveryCache
                ? await discoveryCache.read(partition)
                : undefined;
            capabilities = cached ? safeCliCapabilities(cached) : [];
          } else {
            try {
              capabilities = await loadCapabilities(extracted.refresh);
            } catch (error) {
              if (!(error instanceof UnauthorizedError) || extracted.refresh) {
                throw error;
              }
              capabilities = [];
            }
          }
          io.stdout(
            renderShellCompletions(shell, config, capabilities).trimEnd(),
          );
          return 0;
        }

        if (args[0] === "skill") {
          return await runCustomerSkillCommand({
            argv: args.slice(1),
            config,
            tokenEnvVar,
            io,
            cwd,
            loadCapabilities: (skillRefresh) =>
              loadCapabilities(extracted.refresh || skillRefresh),
          });
        }

        if (args[0] === "commands") {
          const capabilities = await loadCapabilities(extracted.refresh);
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

        // Capability `--help` or live tool execution
        let liveConnection: BrandedCliConnection | undefined;
        try {
          const initialPartition = await resolveCachePartition();
          const cachedTools =
            !extracted.refresh && initialPartition && discoveryCache
              ? await discoveryCache.read(initialPartition)
              : undefined;

          let fromCache = cachedTools !== undefined;
          let capabilities: readonly CliCapability[];
          if (cachedTools !== undefined) {
            capabilities = safeCliCapabilities(cachedTools);
          } else {
            liveConnection = await connector.connect(false);
            const listed = await liveConnection.listTools();
            await writeCachePostConnect(listed.tools);
            capabilities = safeCliCapabilities(listed.tools);
          }

          const wantsHelp = args.at(-1) === "--help";
          if (wantsHelp) {
            let capability: CliCapability;
            try {
              capability = cliCapabilityForCommand(
                capabilities,
                args.slice(0, -1),
              );
            } catch (error) {
              if (!fromCache || !isUnknownCommandOrOptionError(error)) {
                throw error;
              }
              if (initialPartition) {
                await discoveryCache?.invalidate(initialPartition);
              }
              liveConnection = await connector.connect(false);
              const fresh = await liveConnection.listTools();
              await writeCachePostConnect(fresh.tools);
              capabilities = safeCliCapabilities(fresh.tools);
              capability = cliCapabilityForCommand(
                capabilities,
                args.slice(0, -1),
              );
            }
            io.stdout(capabilityHelp(config, capability));
            return 0;
          }

          let invocation: ReturnType<typeof parseCliInvocation>;
          try {
            invocation = parseCliInvocation(capabilities, args);
          } catch (error) {
            if (!fromCache || !isUnknownCommandOrOptionError(error)) {
              throw error;
            }
            if (initialPartition) {
              await discoveryCache?.invalidate(initialPartition);
            }
            fromCache = false;
            liveConnection = await connector.connect(false);
            const fresh = await liveConnection.listTools();
            await writeCachePostConnect(fresh.tools);
            capabilities = safeCliCapabilities(fresh.tools);
            invocation = parseCliInvocation(capabilities, args);
          }

          if (invocationNeedsConfirmation(invocation)) {
            if (!io.isTTY || jsonRequested || extracted.tokenStdin) {
              const refusalMessage = `Refusing a ${invocation.capability.risk} command without --yes in a non-interactive session.`;
              if (jsonRequested || invocation.json) {
                io.stdout(
                  JSON.stringify({
                    ok: false,
                    error: {
                      code: "CONFIRMATION_REQUIRED",
                      risk: invocation.capability.risk,
                      message: refusalMessage,
                    },
                  }),
                );
              } else {
                io.stderr(refusalMessage);
              }
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

          liveConnection ??= await connector.connect(false);
          const result = await liveConnection.callTool({
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
          await liveConnection?.close();
        }
      } catch (error) {
        const auth = error instanceof UnauthorizedError;
        const message = auth
          ? authMode === "token"
            ? `Authentication required. Set ${tokenEnvVar} or run '${config.binaryName} login --token-stdin'.`
            : `Sign in required. Run '${config.binaryName} login'.`
          : errorMessage(error, secretsToScrub);
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
      } finally {
        currentOverride = {};
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
  StaticTokenCredentialStore,
  SystemCredentialStore,
  type SecureCredentialStore,
} from "./cli-auth.js";
export {
  DEFAULT_DISCOVERY_CACHE_TTL_MS,
  FileDiscoveryCache,
  MAX_DISCOVERY_CACHE_TTL_MS,
  type BrandedCliDiscoveryCache,
  type DiscoveryCachePartitionInput,
} from "./cli-discovery-cache.js";
export {
  COMPLETION_SHELLS,
  renderShellCompletions,
  type CompletionShell,
} from "./cli-completions.js";
export {
  CUSTOMER_SKILL_MANIFEST_NAME,
  applyCustomerSkillPlan,
  planCustomerSkill,
  synthesizeCustomerSkillFiles,
  type CustomerSkillAction,
  type CustomerSkillPlan,
  type CustomerSkillTarget,
} from "./cli-customer-skill.js";
export type { CliCapability, CliToolDescriptor } from "./cli-surface.js";
