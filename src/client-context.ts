import type {
  CallToolResult,
  ClientCapabilities,
  ResourceLink,
} from "@modelcontextprotocol/server";
import type { ResultContentComposition } from "./results.js";
import type {
  DeepReadonly,
  ResourceLinkSupport,
  SupabaseMcpClientContext,
  SupabaseMcpClientInfo,
  SupabaseMcpClientPolicy,
  SupabaseMcpClientSupport,
  SupabaseMcpContext,
  SupabaseMcpResultMiddleware,
} from "./types.js";

const utf8 = new TextEncoder();
const controlCharPattern = /[\u0000-\u001f\u007f]/g;
const protocolVersionPattern = /^\d{4}-\d{2}-\d{2}$/;
const sessionMaskPattern = /^cs1_[0-9a-f]{32}_([0-9a-f]{2})$/;
const MAX_CLIENT_STRING_BYTES = 256;

const BIT_ELICITATION_FORM = 1 << 0;
const BIT_ELICITATION_URL = 1 << 1;
const BIT_MCP_APPS_UI = 1 << 2;
const BIT_SAMPLING = 1 << 3;
const BIT_ROOTS = 1 << 4;
const BIT_RESOURCE_LINKS_SUPPORTED = 1 << 5;
const BIT_RESOURCE_LINKS_UNSUPPORTED = 1 << 6;

const KNOWN_NON_RESOURCE_CLIENT_PATTERN =
  /\b(?:chatgpt|openai-mcp|openai-connector)\b/i;

export const DEFAULT_CLIENT_SUPPORT: SupabaseMcpClientSupport = Object.freeze({
  elicitationForm: false,
  elicitationUrl: false,
  mcpAppsUi: false,
  sampling: false,
  roots: false,
  resourceLinks: "unknown",
});

export const DEFAULT_CLIENT_CONTEXT: SupabaseMcpClientContext = Object.freeze({
  era: "modern",
  info: null,
  capabilities: null,
  supports: DEFAULT_CLIENT_SUPPORT,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<Value>(value: Value, seen = new WeakSet<object>()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function sanitizeClientField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(controlCharPattern, "").trim();
  if (!cleaned) return undefined;
  if (utf8.encode(cleaned).byteLength <= MAX_CLIENT_STRING_BYTES) {
    return cleaned;
  }
  let truncated = cleaned.slice(0, MAX_CLIENT_STRING_BYTES);
  while (
    truncated.length > 0 &&
    utf8.encode(truncated).byteLength > MAX_CLIENT_STRING_BYTES
  ) {
    truncated = truncated.slice(0, -1);
  }
  return truncated || undefined;
}

function parseClientInfo(raw: unknown): SupabaseMcpClientInfo | null {
  if (!isRecord(raw)) return null;
  const name = sanitizeClientField(raw.name);
  const version = sanitizeClientField(raw.version);
  if (!name || !version) return null;
  const title = sanitizeClientField(raw.title);
  return Object.freeze({
    name,
    version,
    ...(title ? { title } : {}),
  });
}

function parseClientCapabilities(
  raw: unknown,
): DeepReadonly<ClientCapabilities> | null {
  if (!isRecord(raw)) return null;
  try {
    const cloned = JSON.parse(JSON.stringify(raw)) as unknown;
    if (!isRecord(cloned)) return null;
    return deepFreeze(cloned) as DeepReadonly<ClientCapabilities>;
  } catch {
    return null;
  }
}

function defaultResourceLinkSupport(
  info: SupabaseMcpClientInfo | null,
  userAgent: string | null,
  policy?: SupabaseMcpClientPolicy,
): ResourceLinkSupport {
  if (policy?.resourceLinks) {
    const decided = policy.resourceLinks({ info, userAgent });
    if (
      decided === "supported" ||
      decided === "unsupported" ||
      decided === "unknown"
    ) {
      return decided;
    }
  }
  const combined = `${info?.name ?? ""} ${userAgent ?? ""}`;
  if (KNOWN_NON_RESOURCE_CLIENT_PATTERN.test(combined)) {
    return "unsupported";
  }
  return "unknown";
}

function deriveClientSupport(
  capabilities: DeepReadonly<ClientCapabilities> | null,
  resourceLinks: ResourceLinkSupport,
): SupabaseMcpClientSupport {
  if (!capabilities) {
    return Object.freeze({
      ...DEFAULT_CLIENT_SUPPORT,
      resourceLinks,
    });
  }
  const rawCaps = capabilities as Record<string, unknown>;
  const elicitation = isRecord(rawCaps.elicitation)
    ? rawCaps.elicitation
    : undefined;
  // Per MCP spec, `elicitation: {}` (with neither `form` nor `url` specified)
  // advertises form-mode elicitation; explicit `form` or `url` objects refine it.
  const elicitationForm = Boolean(
    elicitation &&
    (isRecord(elicitation.form) ||
      (elicitation.form === undefined && elicitation.url === undefined)),
  );
  const elicitationUrl = Boolean(elicitation && isRecord(elicitation.url));
  const extensions = isRecord(rawCaps.extensions)
    ? rawCaps.extensions
    : undefined;
  const mcpAppsUi = Boolean(
    extensions && isRecord(extensions["io.modelcontextprotocol/ui"]),
  );
  const sampling = isRecord(rawCaps.sampling);
  const roots = isRecord(rawCaps.roots);

  return Object.freeze({
    elicitationForm,
    elicitationUrl,
    mcpAppsUi,
    sampling,
    roots,
    resourceLinks,
  });
}

/** Encode normalized client support flags into a 2-hex-char bitmask (`00`..`7f`). */
export function encodeClientSupportMask(
  supports: SupabaseMcpClientSupport,
): string {
  let mask = 0;
  if (supports.elicitationForm) mask |= BIT_ELICITATION_FORM;
  if (supports.elicitationUrl) mask |= BIT_ELICITATION_URL;
  if (supports.mcpAppsUi) mask |= BIT_MCP_APPS_UI;
  if (supports.sampling) mask |= BIT_SAMPLING;
  if (supports.roots) mask |= BIT_ROOTS;
  if (supports.resourceLinks === "supported") {
    mask |= BIT_RESOURCE_LINKS_SUPPORTED;
  } else if (supports.resourceLinks === "unsupported") {
    mask |= BIT_RESOURCE_LINKS_UNSUPPORTED;
  }
  return mask.toString(16).padStart(2, "0");
}

/** Decode a `cs1_<32hex>_<2hex>` stateless session ID bitmask, or `null` if not `cs1_`. */
export function decodeClientSupportMask(
  sessionId: string | null | undefined,
): SupabaseMcpClientSupport | null {
  if (!sessionId) return null;
  const match = sessionMaskPattern.exec(sessionId);
  if (!match?.[1]) return null;
  const mask = Number.parseInt(match[1], 16);
  if (!Number.isInteger(mask)) return null;
  const supported = (mask & BIT_RESOURCE_LINKS_SUPPORTED) !== 0;
  const unsupported = (mask & BIT_RESOURCE_LINKS_UNSUPPORTED) !== 0;
  const resourceLinks: ResourceLinkSupport =
    supported && !unsupported
      ? "supported"
      : unsupported && !supported
        ? "unsupported"
        : "unknown";
  return Object.freeze({
    elicitationForm: (mask & BIT_ELICITATION_FORM) !== 0,
    elicitationUrl: (mask & BIT_ELICITATION_URL) !== 0,
    mcpAppsUi: (mask & BIT_MCP_APPS_UI) !== 0,
    sampling: (mask & BIT_SAMPLING) !== 0,
    roots: (mask & BIT_ROOTS) !== 0,
    resourceLinks,
  });
}

export interface ClientEnvelopeInput {
  readonly era: "modern" | "legacy";
  readonly protocolVersion?: string;
  readonly rawClientInfo?: unknown;
  readonly rawCapabilities?: unknown;
}

export function resolveMcpClientContext(
  request: Request,
  envelope: ClientEnvelopeInput,
  options?: {
    readonly sessionId?: string | null;
    readonly clientPolicy?: SupabaseMcpClientPolicy;
  },
): SupabaseMcpClientContext {
  const userAgent =
    sanitizeClientField(request.headers.get("user-agent")) ?? null;
  const info = parseClientInfo(envelope.rawClientInfo);
  const capabilities = parseClientCapabilities(envelope.rawCapabilities);
  const headerVersion = request.headers.get("mcp-protocol-version")?.trim();
  const candidateVersion = envelope.protocolVersion ?? headerVersion ?? "";
  const protocolVersion = protocolVersionPattern.test(candidateVersion)
    ? candidateVersion
    : undefined;

  let supports: SupabaseMcpClientSupport;
  if (capabilities !== null || info !== null) {
    const resourceLinks = defaultResourceLinkSupport(
      info,
      userAgent,
      options?.clientPolicy,
    );
    supports = deriveClientSupport(capabilities, resourceLinks);
  } else {
    const recovered =
      envelope.era === "legacy"
        ? decodeClientSupportMask(options?.sessionId)
        : null;
    if (recovered) {
      const policyOverride = options?.clientPolicy?.resourceLinks?.({
        info: null,
        userAgent,
      });
      supports =
        policyOverride && policyOverride !== recovered.resourceLinks
          ? Object.freeze({ ...recovered, resourceLinks: policyOverride })
          : recovered;
    } else {
      supports = Object.freeze({
        ...DEFAULT_CLIENT_SUPPORT,
        resourceLinks: defaultResourceLinkSupport(
          null,
          userAgent,
          options?.clientPolicy,
        ),
      });
    }
  }

  return Object.freeze({
    era: envelope.era,
    ...(protocolVersion ? { protocolVersion } : {}),
    info,
    capabilities,
    supports,
  });
}

export interface ResourceLinkFallbackMiddlewareOptions<Database = unknown> {
  /**
   * Optional recovery hint appended to synthesized reading cards (for example,
   * naming a read tool that accepts the resource URI).
   */
  resolveFallbackHint?(
    link: ResourceLink,
    context: SupabaseMcpContext<Database>,
  ): string | undefined | Promise<string | undefined>;
}

function formatResourceLinkCard(link: ResourceLink, hint?: string): string {
  const label = link.title?.trim() || link.name.trim() || link.uri;
  const parts = [`Resource: ${label} (${link.uri})`];
  if (link.mimeType?.trim()) parts[0] += ` [${link.mimeType.trim()}]`;
  if (link.description?.trim()) parts.push(link.description.trim());
  if (hint?.trim()) parts.push(hint.trim());
  return parts.join("\n");
}

/**
 * Result middleware that guarantees every `CallToolResult` containing a
 * `resource_link` also carries a non-empty text reading card when the caller's
 * host is not known to dereference `resource_link` blocks natively.
 */
export function resourceLinkFallbackMiddleware<Database = unknown>(
  options: ResourceLinkFallbackMiddlewareOptions<Database> = {},
): SupabaseMcpResultMiddleware<Database> {
  return async ({
    context,
    result,
  }): Promise<ResultContentComposition | null> => {
    if (context.client.supports.resourceLinks === "supported") return null;
    const content =
      result.content as readonly CallToolResult["content"][number][];
    const hasNonEmptyText = content.some(
      (block) => block.type === "text" && block.text.trim().length > 0,
    );
    if (hasNonEmptyText) return null;

    const resourceLinks = content.filter(
      (block): block is ResourceLink => block.type === "resource_link",
    );
    if (resourceLinks.length === 0) return null;

    const cards: string[] = [];
    for (const link of resourceLinks) {
      const hint = await options.resolveFallbackHint?.(link, context);
      cards.push(formatResourceLinkCard(link, hint));
    }
    return {
      prepend: [{ type: "text", text: cards.join("\n\n") }],
    };
  };
}
