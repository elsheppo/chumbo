export type ConnectAuthMode = "oauth" | "bearer" | "api-key" | "public";

export type AgentClientId =
  | "claude"
  | "chatgpt"
  | "claude-code"
  | "cursor"
  | "cli";

export type AgentClientAvailability =
  | "ready"
  | "unsupported_auth_mode"
  | "requires_https_endpoint";

export interface ConnectCliMetadata {
  readonly packageName: string;
  readonly binaryName: string;
  /** Env var name shown in headless/API-key examples (default: `<BIN>_TOKEN`). Never pass a secret value! */
  readonly tokenEnvVar?: string;
}

export interface ConnectToAgentInput {
  /** Human-facing product name (e.g. "Acme Ops"). */
  readonly productName: string;
  /** Short slug for `claude mcp add` and `.cursor/mcp.json` (default: kebab-case `productName`). */
  readonly serverSlug?: string;
  /** Canonical MCP URL (HTTPS in production, or loopback HTTP in local dev). */
  readonly endpoint: string;
  /** Server authentication mode (`oauth` default). */
  readonly authMode?: ConnectAuthMode;
  /** Custom token header name for `api-key` / `bearer` modes (default: `"Authorization"`). */
  readonly headerName?: string;
  /** Environment variable placeholder used in `claude-code`, `cursor`, and `cli` snippets (default: `<SLUG>_TOKEN`). */
  readonly tokenEnvVar?: string;
  /** Optional sign-in guidance for OAuth (e.g. "Sign in with your work email and 8-digit code."). */
  readonly signInNote?: string;
  /** Optional in-app path where users revoke connections (e.g. "Settings -> Integrations"). */
  readonly disconnectLocation?: string;
  /** Optional support contact line (e.g. "support@acme.com"). */
  readonly supportContact?: string;
  /** Optional starter prompts shown under "What you can ask". */
  readonly samplePrompts?: readonly string[];
  /** Optional branded CLI metadata; enables the `<binary> CLI` tab. */
  readonly cli?: ConnectCliMetadata;
}

export interface CopyableSnippet {
  readonly id: string;
  readonly label: string;
  readonly language: "sh" | "json" | "url";
  readonly code: string;
}

export interface AgentClientConnection {
  readonly id: AgentClientId;
  readonly label: string;
  readonly availability: AgentClientAvailability;
  readonly unavailableReason?: string;
  readonly summary: string;
  readonly steps: readonly string[];
  readonly snippets: readonly CopyableSnippet[];
  /** Present on `cursor` when `availability === "ready"`. Never contains raw secrets. */
  readonly deeplink?: {
    readonly label: string;
    readonly href: string;
  };
  readonly notes: readonly string[];
  readonly reconnectHint?: string;
  readonly disconnectHint?: string;
}

export interface AgentConnectionPlan {
  readonly valid: boolean;
  readonly error?: string;
  readonly productName: string;
  readonly serverSlug: string;
  readonly endpoint: string;
  readonly isLoopback: boolean;
  readonly authMode: ConnectAuthMode;
  /** Truthful authority summary matching the active `authMode`. */
  readonly authoritySummary: string;
  readonly clients: readonly AgentClientConnection[];
  readonly samplePrompts: readonly string[];
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const ENV_VAR_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/u;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/u;
const CLI_BINARY_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const NPM_PACKAGE_PATTERN = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/u;
const SAFE_BARE_SHELL_URL_PATTERN = /^[A-Za-z0-9:/._~-]+=*$/u;

const VALID_AUTH_MODES = new Set<ConnectAuthMode>([
  "oauth",
  "bearer",
  "api-key",
  "public",
]);

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function deriveSlug(productName: string): string {
  const cleaned = productName
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 63)
    .replace(/-+$/gu, "");
  return cleaned && SLUG_PATTERN.test(cleaned) ? cleaned : "mcp";
}

function deriveEnvVarName(slugOrBin: string): string {
  const base = slugOrBin
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  const prefixed = /^[A-Z]/u.test(base) ? base : `MCP_${base || "SERVER"}`;
  const candidate = `${prefixed.slice(0, 56)}_TOKEN`;
  return ENV_VAR_PATTERN.test(candidate) ? candidate : "MCP_SERVER_TOKEN";
}

function shellQuoteArg(value: string): string {
  if (SAFE_BARE_SHELL_URL_PATTERN.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function cleanInlineText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function authoritySummaryFor(
  authMode: ConnectAuthMode,
  isLoopback: boolean,
): string {
  const base =
    authMode === "oauth"
      ? "Your assistant only sees what your signed-in account can already access."
      : authMode === "public"
        ? "Anyone with this address can call public capabilities (rate limited)."
        : authMode === "bearer"
          ? "Requests use the supplied user token's permissions."
          : "Requests run with your API key's permissions.";
  return isLoopback
    ? `${base} Local development endpoint – reachable only from this machine.`
    : base;
}

function invalidPlan(
  input: Partial<ConnectToAgentInput>,
  error: string,
): AgentConnectionPlan {
  const rawMode = input.authMode ?? "oauth";
  const authMode: ConnectAuthMode = VALID_AUTH_MODES.has(rawMode)
    ? rawMode
    : "oauth";
  const productName =
    typeof input.productName === "string" ? input.productName.trim() : "";
  return Object.freeze({
    valid: false,
    error,
    productName,
    serverSlug: productName ? deriveSlug(productName) : "mcp",
    endpoint: "",
    isLoopback: false,
    authMode,
    authoritySummary: authoritySummaryFor(authMode, false),
    clients: Object.freeze([]),
    samplePrompts: Object.freeze([]),
  });
}

export function describeAgentConnections(
  input: ConnectToAgentInput,
): AgentConnectionPlan {
  if (
    typeof input?.productName !== "string" ||
    !input.productName.trim() ||
    CONTROL_CHAR_PATTERN.test(input.productName)
  ) {
    return invalidPlan(input ?? {}, "A valid product name is required.");
  }
  const productName = input.productName.trim();

  const authMode = input.authMode ?? "oauth";
  if (!VALID_AUTH_MODES.has(authMode)) {
    return invalidPlan(
      input,
      "Authentication mode must be oauth, bearer, api-key, or public.",
    );
  }

  if (typeof input.endpoint !== "string" || !input.endpoint.trim()) {
    return invalidPlan(input, "An MCP endpoint URL is required.");
  }
  const rawEndpoint = input.endpoint.trim();
  if (CONTROL_CHAR_PATTERN.test(rawEndpoint) || /\s/u.test(rawEndpoint)) {
    return invalidPlan(
      input,
      "The MCP endpoint URL must not contain whitespace or control characters.",
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawEndpoint);
  } catch {
    return invalidPlan(input, "The MCP endpoint must be a valid URL.");
  }

  if (parsedUrl.username || parsedUrl.password) {
    return invalidPlan(
      input,
      "The MCP endpoint URL must not contain embedded credentials.",
    );
  }

  const isLoopback = isLoopbackHost(parsedUrl.hostname);
  if (
    parsedUrl.protocol !== "https:" &&
    !(parsedUrl.protocol === "http:" && isLoopback)
  ) {
    return invalidPlan(
      input,
      "The MCP endpoint must use https:// (or http:// on localhost / 127.0.0.1 for local development).",
    );
  }

  // `parsedUrl.href` converts IDN hostnames to ASCII Punycode and percent-encodes
  // non-ASCII path/query characters so `btoa` for Cursor deeplinks is guaranteed ASCII.
  const canonicalEndpoint = parsedUrl.href;

  let serverSlug: string;
  if (input.serverSlug !== undefined) {
    const candidate = input.serverSlug.trim();
    if (!SLUG_PATTERN.test(candidate)) {
      return invalidPlan(
        input,
        "serverSlug must contain only lowercase letters, numbers, and hyphens.",
      );
    }
    serverSlug = candidate;
  } else {
    serverSlug = deriveSlug(productName);
  }

  const headerName =
    input.headerName !== undefined ? input.headerName.trim() : "Authorization";
  if (!HEADER_NAME_PATTERN.test(headerName)) {
    return invalidPlan(input, "headerName must be a valid HTTP header token.");
  }

  const tokenEnvVar =
    input.tokenEnvVar !== undefined
      ? input.tokenEnvVar.trim()
      : deriveEnvVarName(serverSlug);
  if (!ENV_VAR_PATTERN.test(tokenEnvVar)) {
    return invalidPlan(
      input,
      "tokenEnvVar must be an uppercase environment variable name (such as ACME_TOKEN), never a secret value.",
    );
  }

  let validatedCli:
    | {
        readonly packageName: string;
        readonly binaryName: string;
        readonly tokenEnvVar: string;
      }
    | undefined;
  if (input.cli !== undefined) {
    const packageName = input.cli.packageName.trim();
    const binaryName = input.cli.binaryName.trim();
    if (!NPM_PACKAGE_PATTERN.test(packageName)) {
      return invalidPlan(
        input,
        "cli.packageName must be a valid npm package name.",
      );
    }
    if (!CLI_BINARY_PATTERN.test(binaryName)) {
      return invalidPlan(
        input,
        "cli.binaryName must be a lowercase kebab-case command name.",
      );
    }
    const cliEnvVar =
      input.cli.tokenEnvVar !== undefined
        ? input.cli.tokenEnvVar.trim()
        : input.tokenEnvVar !== undefined
          ? tokenEnvVar
          : deriveEnvVarName(binaryName);
    if (!ENV_VAR_PATTERN.test(cliEnvVar)) {
      return invalidPlan(
        input,
        "cli.tokenEnvVar must be an uppercase environment variable name.",
      );
    }
    validatedCli = { packageName, binaryName, tokenEnvVar: cliEnvVar };
  }

  const signInNote = cleanInlineText(input.signInNote);
  const disconnectLocation = cleanInlineText(input.disconnectLocation);
  const samplePrompts = Object.freeze(
    (input.samplePrompts ?? [])
      .map((prompt) => cleanInlineText(prompt))
      .filter((prompt): prompt is string => Boolean(prompt)),
  );

  const isTokenHeaderMode = authMode === "api-key" || authMode === "bearer";
  const isBearerHeader = headerName.toLowerCase() === "authorization";

  // 1. Claude (Claude.ai & Claude Desktop)
  const claudeClient: AgentClientConnection = isLoopback
    ? {
        id: "claude",
        label: "Claude",
        availability: "requires_https_endpoint",
        unavailableReason:
          "Claude custom connectors run in the cloud and cannot reach a local 127.0.0.1 or localhost address. Use Claude Code, Cursor, or the CLI locally, or deploy an HTTPS endpoint.",
        summary: "Requires a deployed HTTPS MCP address.",
        steps: Object.freeze([]),
        snippets: Object.freeze([]),
        notes: Object.freeze([]),
      }
    : isTokenHeaderMode
      ? {
          id: "claude",
          label: "Claude",
          availability: "unsupported_auth_mode",
          unavailableReason:
            "Claude custom connectors use OAuth or public HTTPS and do not send static API-key or bearer headers. Connect with Claude Code, Cursor, or the CLI instead.",
          summary:
            "Custom connectors in Claude require OAuth or public access.",
          steps: Object.freeze([]),
          snippets: Object.freeze([]),
          notes: Object.freeze([]),
        }
      : {
          id: "claude",
          label: "Claude",
          availability: "ready",
          summary: `Connect ${productName} in Claude on the web or desktop.`,
          steps: Object.freeze(
            authMode === "oauth"
              ? [
                  "Open Claude and go to Customize -> Connectors -> Add custom connector.",
                  `Enter "${productName}" as the name and paste the MCP address below.`,
                  `Select Add, then complete sign-in in your browser.${signInNote ? ` ${signInNote}` : ""}`,
                  "In a conversation, open + -> Connectors and enable the connector.",
                ]
              : [
                  "Open Claude and go to Customize -> Connectors -> Add custom connector.",
                  `Enter "${productName}" as the name and paste the MCP address below.`,
                  "Select Add, then open + -> Connectors in a conversation to enable it.",
                ],
          ),
          snippets: Object.freeze([
            {
              id: "claude-endpoint",
              label: "MCP connection address",
              language: "url" as const,
              code: canonicalEndpoint,
            },
          ]),
          notes: Object.freeze([]),
          ...(authMode === "oauth"
            ? {
                reconnectHint:
                  "If tools stop responding after session expiry, open Customize -> Connectors in Claude and select Reconnect.",
              }
            : {}),
          disconnectHint: disconnectLocation
            ? `Remove the connector in Claude (Customize -> Connectors), or revoke access in ${productName} under ${disconnectLocation}.`
            : "Remove the connector at any time in Claude under Customize -> Connectors.",
        };

  // 2. ChatGPT
  const chatgptClient: AgentClientConnection = isLoopback
    ? {
        id: "chatgpt",
        label: "ChatGPT",
        availability: "requires_https_endpoint",
        unavailableReason:
          "ChatGPT connectors run in the cloud and cannot reach a local 127.0.0.1 or localhost address. Use Claude Code, Cursor, or the CLI locally, or deploy an HTTPS endpoint.",
        summary: "Requires a deployed HTTPS MCP address.",
        steps: Object.freeze([]),
        snippets: Object.freeze([]),
        notes: Object.freeze([]),
      }
    : isTokenHeaderMode
      ? {
          id: "chatgpt",
          label: "ChatGPT",
          availability: "unsupported_auth_mode",
          unavailableReason:
            "ChatGPT custom connectors use OAuth or public HTTPS and do not send static API-key or bearer headers. Connect with Claude Code, Cursor, or the CLI instead.",
          summary:
            "Custom connectors in ChatGPT require OAuth or public access.",
          steps: Object.freeze([]),
          snippets: Object.freeze([]),
          notes: Object.freeze([]),
        }
      : {
          id: "chatgpt",
          label: "ChatGPT",
          availability: "ready",
          summary: `Connect ${productName} as a custom MCP connector in ChatGPT.`,
          steps: Object.freeze(
            authMode === "oauth"
              ? [
                  "Open ChatGPT Settings -> Connectors -> Add custom connector.",
                  `Enter "${productName}" as the name and paste the MCP address below.`,
                  `Continue to sign in and approve access.${signInNote ? ` ${signInNote}` : ""}`,
                ]
              : [
                  "Open ChatGPT Settings -> Connectors -> Add custom connector.",
                  `Enter "${productName}" as the name and paste the MCP address below.`,
                ],
          ),
          snippets: Object.freeze([
            {
              id: "chatgpt-endpoint",
              label: "MCP connection address",
              language: "url" as const,
              code: canonicalEndpoint,
            },
          ]),
          notes: Object.freeze([
            "Custom MCP connectors require a supported ChatGPT plan and workspace developer/connector permissions enabled by your administrator.",
          ]),
          ...(authMode === "oauth"
            ? {
                reconnectHint:
                  "Open Settings -> Connectors in ChatGPT and reconnect if your session expires.",
              }
            : {}),
          disconnectHint: disconnectLocation
            ? `Disconnect in ChatGPT under Settings -> Connectors, or revoke access in ${productName} under ${disconnectLocation}.`
            : "Disconnect at any time in ChatGPT under Settings -> Connectors.",
        };

  // 3. Claude Code
  const claudeCodeHeaderArg = isBearerHeader
    ? `${headerName}: Bearer \${${tokenEnvVar}}`
    : `${headerName}: \${${tokenEnvVar}}`;
  const claudeCodeCommand = isTokenHeaderMode
    ? `claude mcp add --transport http ${serverSlug} ${shellQuoteArg(canonicalEndpoint)} --header "${claudeCodeHeaderArg}"`
    : `claude mcp add --transport http ${serverSlug} ${shellQuoteArg(canonicalEndpoint)}`;

  const claudeCodeClient: AgentClientConnection = {
    id: "claude-code",
    label: "Claude Code",
    availability: "ready",
    summary: `Add ${productName} to Claude Code over Streamable HTTP.`,
    steps: Object.freeze(
      authMode === "oauth"
        ? [
            "Run the command below in your terminal to register the MCP connection.",
            `Start Claude Code and run /mcp to complete browser sign-in.${signInNote ? ` ${signInNote}` : ""}`,
          ]
        : isTokenHeaderMode
          ? [
              `Export ${tokenEnvVar} in your shell environment before launching Claude Code.`,
              "Run the command below to register the authenticated HTTP connection.",
            ]
          : ["Run the command below in your terminal."],
    ),
    snippets: Object.freeze([
      {
        id: "claude-code-add",
        label: "Add MCP server in Claude Code",
        language: "sh" as const,
        code: claudeCodeCommand,
      },
    ]),
    notes: Object.freeze(
      isTokenHeaderMode
        ? [
            `Keep your credential in ${tokenEnvVar} so it is not written as plaintext in shell history.`,
          ]
        : [],
    ),
    ...(authMode === "oauth"
      ? {
          reconnectHint:
            "Run /mcp inside Claude Code to re-authenticate if your token expires.",
        }
      : {}),
    disconnectHint: `Run \`claude mcp remove ${serverSlug}\` to remove the connection.`,
  };

  // 4. Cursor
  const cursorServerEntry: Record<string, unknown> = isTokenHeaderMode
    ? {
        url: canonicalEndpoint,
        headers: {
          [headerName]: isBearerHeader
            ? `Bearer \${env:${tokenEnvVar}}`
            : `\${env:${tokenEnvVar}}`,
        },
      }
    : { url: canonicalEndpoint };

  const cursorEncodedConfig = btoa(JSON.stringify(cursorServerEntry));
  const cursorDeeplinkHref = `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(serverSlug)}&config=${encodeURIComponent(cursorEncodedConfig)}`;
  const cursorMcpJson = JSON.stringify(
    { mcpServers: { [serverSlug]: cursorServerEntry } },
    null,
    2,
  );

  const cursorClient: AgentClientConnection = {
    id: "cursor",
    label: "Cursor",
    availability: "ready",
    summary: `Install ${productName} in Cursor with one click or via .cursor/mcp.json.`,
    steps: Object.freeze(
      isTokenHeaderMode
        ? [
            `Set ${tokenEnvVar} in the environment that launches Cursor.`,
            "Open the Cursor install link, or add the JSON configuration below to .cursor/mcp.json.",
          ]
        : authMode === "oauth"
          ? [
              "Open the Cursor install link, or add the JSON configuration below to .cursor/mcp.json.",
              `Approve browser sign-in when Cursor prompts to connect.${signInNote ? ` ${signInNote}` : ""}`,
            ]
          : [
              "Open the Cursor install link, or add the JSON configuration below to .cursor/mcp.json.",
            ],
    ),
    snippets: Object.freeze([
      {
        id: "cursor-mcp-json",
        label: ".cursor/mcp.json",
        language: "json" as const,
        code: cursorMcpJson,
      },
    ]),
    deeplink: Object.freeze({
      label: "Open in Cursor",
      href: cursorDeeplinkHref,
    }),
    notes: Object.freeze(
      isTokenHeaderMode
        ? [
            `Cursor interpolates \${env:${tokenEnvVar}} at runtime so no live credential is stored in .cursor/mcp.json.`,
          ]
        : [],
    ),
    disconnectHint:
      "Disable or remove the server in Cursor Settings -> Tools & MCP.",
  };

  const clients: AgentClientConnection[] = [
    claudeClient,
    chatgptClient,
    claudeCodeClient,
    cursorClient,
  ];

  // 5. Optional Branded CLI
  if (validatedCli) {
    const { packageName, binaryName, tokenEnvVar: cliTokenEnv } = validatedCli;
    const cliSnippetCode =
      authMode === "oauth"
        ? [
            `npm install --global ${packageName}`,
            `${binaryName} login`,
            `${binaryName} commands`,
          ].join("\n")
        : authMode === "public"
          ? [
              `npm install --global ${packageName}`,
              `${binaryName} commands`,
            ].join("\n")
          : [
              `npm install --global ${packageName}`,
              `export ${cliTokenEnv}="<your-token>"`,
              `${binaryName} commands`,
            ].join("\n");

    clients.push({
      id: "cli",
      label: `${binaryName} CLI`,
      availability: "ready",
      summary: `Run ${productName} commands directly from your terminal or coding agent.`,
      steps: Object.freeze(
        authMode === "oauth"
          ? [
              `Install ${packageName} from npm.`,
              `Run \`${binaryName} login\` to sign in through your browser and store credentials in your OS keychain.`,
              `Run \`${binaryName} commands\` to inspect available commands, or \`${binaryName} skill install\` for coding agents.`,
            ]
          : authMode === "public"
            ? [
                `Install ${packageName} from npm.`,
                `Run \`${binaryName} commands\` to inspect available commands.`,
              ]
            : [
                `Install ${packageName} from npm.`,
                `Set ${cliTokenEnv} in your shell (or store it in your keychain via \`${binaryName} login --token-stdin\`).`,
                `Run \`${binaryName} commands\` to inspect available commands.`,
              ],
      ),
      snippets: Object.freeze([
        {
          id: "cli-quickstart",
          label: `Install and run ${binaryName}`,
          language: "sh" as const,
          code: cliSnippetCode,
        },
      ]),
      notes: Object.freeze(
        authMode === "oauth"
          ? [
              `For headless CI or coding agents, set ${cliTokenEnv} or install project agent guidance with \`${binaryName} skill install\`.`,
            ]
          : [
              `Install project agent guidance with \`${binaryName} skill install\`.`,
            ],
      ),
      ...(authMode === "oauth"
        ? {
            reconnectHint: `Run \`${binaryName} login\` to refresh your keychain session, or \`${binaryName} status\` to verify connectivity.`,
          }
        : {}),
      disconnectHint: `Run \`${binaryName} logout\` to clear stored credentials and cached command metadata.`,
    });
  }

  return Object.freeze({
    valid: true,
    productName,
    serverSlug,
    endpoint: canonicalEndpoint,
    isLoopback,
    authMode,
    authoritySummary: authoritySummaryFor(authMode, isLoopback),
    clients: Object.freeze(clients),
    samplePrompts,
  });
}

/** Renders a complete end-user Markdown setup guide for the configured MCP server. */
export function renderConnectMarkdown(input: ConnectToAgentInput): string {
  const plan = describeAgentConnections(input);
  if (!plan.valid) {
    return `# Connect your AI assistant\n\nConfiguration incomplete: ${plan.error ?? "Check the MCP connection settings."}\n`;
  }

  const lines: string[] = [
    `# Connect your AI assistant to ${plan.productName}`,
    "",
    plan.authoritySummary,
    "",
    "**MCP connection address**",
    "",
    "```url",
    plan.endpoint,
    "```",
  ];

  const readyClients = plan.clients.filter(
    (client) => client.availability === "ready",
  );
  const unavailableClients = plan.clients.filter(
    (client) => client.availability !== "ready",
  );

  for (const client of readyClients) {
    lines.push("", `## ${client.label}`, "", client.summary);
    if (client.steps.length > 0) {
      lines.push("");
      client.steps.forEach((step, index) => {
        lines.push(`${index + 1}. ${step}`);
      });
    }
    if (client.deeplink) {
      lines.push("", `[${client.deeplink.label}](${client.deeplink.href})`);
    }
    for (const snippet of client.snippets) {
      lines.push(
        "",
        `**${snippet.label}**`,
        "",
        `\`\`\`${snippet.language}`,
        snippet.code,
        "```",
      );
    }
    for (const note of client.notes) {
      lines.push("", `> ${note}`);
    }
  }

  if (unavailableClients.length > 0) {
    lines.push("", "## Client compatibility notes", "");
    for (const client of unavailableClients) {
      lines.push(
        `- **${client.label}:** ${client.unavailableReason ?? client.summary}`,
      );
    }
  }

  if (plan.samplePrompts.length > 0) {
    lines.push("", "## What you can ask", "");
    for (const prompt of plan.samplePrompts) {
      lines.push(`- "${prompt}"`);
    }
  }

  const troubleshooting: string[] = [];
  for (const client of readyClients) {
    if (client.reconnectHint) {
      troubleshooting.push(
        `- **${client.label} reconnect:** ${client.reconnectHint}`,
      );
    }
    if (client.disconnectHint) {
      troubleshooting.push(
        `- **${client.label} disconnect:** ${client.disconnectHint}`,
      );
    }
  }
  const supportContact = cleanInlineText(input.supportContact);
  if (supportContact) {
    troubleshooting.push(`- **Support:** ${supportContact}`);
  }
  if (troubleshooting.length > 0) {
    lines.push(
      "",
      "## Troubleshooting & disconnecting",
      "",
      ...troubleshooting,
    );
  }

  lines.push("");
  return lines.join("\n");
}
