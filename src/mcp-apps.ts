import type {
  CallToolResult,
  McpServer,
  RegisteredResource,
  RegisteredTool,
  StandardSchemaWithJSON,
  ToolAnnotations,
  ToolCallback,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ChumboCapabilityRisk } from "./capabilities.js";
import {
  buildHubUrl,
  canonicalAppAssetUrl,
  canonicalAppOrigin,
  HEX_COLOR_PATTERN,
  MCP_APP_PRESENTATION_SCRIPT_ID,
  NEUTRAL_APP_PRESENTATION,
  PLAIN_FONT_FAMILY_PATTERN,
  sanitizeAppPresentationPayload,
  type McpAppBrand,
  type McpAppBrandColors,
  type McpAppPresentation,
  type McpAppThemePalette,
} from "./internal/app-presentation-shared.js";
import { errorResult } from "./results.js";
import type { SupabaseMcpServer } from "./types.js";

export {
  buildHubUrl,
  MCP_APP_PRESENTATION_SCRIPT_ID,
  NEUTRAL_APP_PRESENTATION,
  type McpAppBrand,
  type McpAppBrandColors,
  type McpAppPresentation,
  type McpAppThemePalette,
};

export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app" as const;
export const MCP_APP_RESOURCE_URI_META_KEY = "ui/resourceUri" as const;
export const MCP_APP_PRESENTATION_PLACEHOLDER =
  "__MCP_APP_PRESENTATION__" as const;

export type McpAppUri = `ui://${string}`;
export type McpAppToolVisibility = "model" | "app";

export class McpAppPresentationError extends Error {
  readonly code: "presentation_invalid" | "presentation_placeholder_invalid";

  constructor(
    code: "presentation_invalid" | "presentation_placeholder_invalid",
    message: string,
  ) {
    super(message);
    this.name = "McpAppPresentationError";
    this.code = code;
  }
}

/** SEP-1865 Content Security Policy origin allowlists for a `ui://` Resource. */
export interface McpAppCsp {
  /** Maps to CSP `connect-src`. Omitted/empty -> `connect-src 'none'`. */
  readonly connectDomains?: readonly string[];
  /** Maps to CSP `img-src`, `style-src`, `script-src`, `font-src`, `media-src`. */
  readonly resourceDomains?: readonly string[];
  /** Maps to CSP `frame-src`. Omitted/empty -> `frame-src 'none'`. */
  readonly frameDomains?: readonly string[];
  /** Maps to CSP `base-uri`. Omitted/empty -> `base-uri 'none'` / `'self'`. */
  readonly baseUriDomains?: readonly string[];
}

/** SEP-1865 iframe Permission Policy requests. */
export interface McpAppPermissions {
  readonly camera?: Readonly<Record<string, never>>;
  readonly microphone?: Readonly<Record<string, never>>;
  readonly geolocation?: Readonly<Record<string, never>>;
  readonly clipboardWrite?: Readonly<Record<string, never>>;
}

export interface McpAppResourceMeta {
  readonly [key: string]: unknown;
  readonly ui: {
    readonly csp: McpAppCsp;
    readonly permissions?: McpAppPermissions;
    readonly domain?: string;
    readonly prefersBorder?: boolean;
  };
}

export interface McpAppToolMeta {
  readonly [key: string]: unknown;
  readonly ui: {
    readonly resourceUri: McpAppUri;
    readonly visibility: readonly McpAppToolVisibility[];
  };
  readonly "ui/resourceUri": McpAppUri;
}

export interface McpAppCspInput {
  /** HTTPS origins (e.g. `"https://files.example.com"`) for `fetch`/XHR/WebSocket. */
  readonly connectOrigins?: readonly string[];
  /** HTTPS origins (or `"https://*.example.com"`) for images, media, or styles. */
  readonly resourceOrigins?: readonly string[];
  /** HTTPS origins for nested iframes. */
  readonly frameOrigins?: readonly string[];
  /** HTTPS origins for document `<base>`. */
  readonly baseUriOrigins?: readonly string[];
  /** Permit `http://localhost:<port>` and `http://127.0.0.1:<port>` origins in local dev. */
  readonly allowLocalhostOrigins?: boolean;
}

export interface McpAppReadContext {
  readonly uri: URL;
  readonly presentation: McpAppPresentation;
}

export interface McpAppDefinition {
  /** Stable resource name passed to `server.registerResource` (kebab-case, e.g. `"review-queue"`). */
  readonly name: string;
  /** Canonical `ui://<namespace>/<view>.html` identifier. Validated at definition time. */
  readonly uri: McpAppUri;
  /** Static title or presentation-derived title. */
  readonly title: string | ((presentation: McpAppPresentation) => string);
  readonly description: string;
  /**
   * Default scope gate required to discover and read the HTML Resource, and
   * inherited by `openTool` and read-only `appTool` registrations when their own
   * `scopes` field is omitted. Mutating `appTool`s on a scoped app MUST declare
   * explicit `scopes` so `visibility: ["app"]` is never mistaken for authority.
   */
  readonly scopes?: readonly string[];
  /**
   * Compiled single-file HTML string (e.g. imported from `generated/apps/<name>.html.ts`)
   * or an async reader (e.g. `() => Deno.readTextFile(...)`).
   */
  readonly html:
    | string
    | ((context: McpAppReadContext) => string | Promise<string>);
  /** Static baseline CSP origins. Merged with per-registration origins and presentation logos. */
  readonly csp?: McpAppCspInput;
  readonly permissions?: McpAppPermissions;
  /** Defaults to `true` (explicit host border preference recommended by SEP-1865). */
  readonly prefersBorder?: boolean;
  /** Optional host-specific dedicated sandbox domain. */
  readonly domain?: string;
}

export interface DefinedMcpApp extends Readonly<McpAppDefinition> {
  readonly uri: McpAppUri;
  readonly scopes: readonly string[];
}

export interface RegisterMcpAppOptions {
  /**
   * Per-connection tenant presentation injected into `<script id="mcp-app-presentation">`.
   * Defaults to `NEUTRAL_APP_PRESENTATION`.
   */
  readonly presentation?: McpAppPresentation;
  /** Additional request/deployment-specific CSP origins (e.g. signed file delivery edge). */
  readonly csp?: McpAppCspInput;
  /** Override the Resource's required scopes for this registration. */
  readonly scopes?: readonly string[];
  /**
   * Presentation injection behavior:
   * - `"auto"` (default): replaces `__MCP_APP_PRESENTATION__` if present (throwing if >1 occurrence),
   *   otherwise leaves static HTML without a placeholder untouched.
   * - `"placeholder"`: requires `__MCP_APP_PRESENTATION__` to occur exactly once.
   * - `"none"`: disables HTML injection.
   */
  readonly injectPresentation?: "auto" | "placeholder" | "none";
}

export interface OpenToolConfig<
  Input extends StandardSchemaWithJSON | undefined = undefined,
  Output extends StandardSchemaWithJSON | undefined = undefined,
> {
  readonly title?: string;
  readonly description: string;
  readonly inputSchema?: Input;
  readonly outputSchema?: Output;
  /** Defaults to the parent app's `scopes`. */
  readonly scopes?: readonly string[];
  /** Defaults to `"read"` (`readOnlyHint: true, destructiveHint: false`). */
  readonly risk?: ChumboCapabilityRisk;
  readonly idempotent?: boolean;
  readonly annotations?: ToolAnnotations;
  /** Defaults to `["model"]`. Set `["model", "app"]` when the View also re-invokes its opener. */
  readonly visibility?: readonly ["model"] | readonly ["model", "app"];
  readonly _meta?: Readonly<Record<string, unknown>>;
}

export interface AppToolConfig<
  Input extends StandardSchemaWithJSON | undefined = undefined,
  Output extends StandardSchemaWithJSON | undefined = undefined,
> {
  readonly title?: string;
  readonly description: string;
  readonly inputSchema?: Input;
  readonly outputSchema?: Output;
  /**
   * Required when `risk !== "read"` and the parent app or registration declares non-empty `scopes`.
   * Pass explicit write scopes (e.g. `["review:decide"]`), or `[]` only when every authenticated
   * caller may invoke the handler and RLS/RPC checks enforce authorization.
   */
  readonly scopes?: readonly string[];
  /** Explicit safety classification (`"read" | "write" | "destructive"`). Validated against `annotations`. */
  readonly risk: ChumboCapabilityRisk;
  /** Defaults to `true` for `"read"`, `false` otherwise. Set `true` when paired with `request_id`. */
  readonly idempotent?: boolean;
  readonly annotations?: ToolAnnotations;
  readonly _meta?: Readonly<Record<string, unknown>>;
}

export interface RegisteredMcpApp {
  readonly uri: McpAppUri;
  readonly resource: RegisteredResource;
  readonly resourceMeta: McpAppResourceMeta;
  /** Register a model-visible tool (`visibility: ["model"]` by default) linked to this `ui://` View. */
  openTool<
    Input extends StandardSchemaWithJSON | undefined = undefined,
    Output extends StandardSchemaWithJSON | undefined = undefined,
  >(
    name: string,
    config: OpenToolConfig<Input, Output>,
    handler: ToolCallback<Input>,
  ): RegisteredTool;
  /** Register a View-only tool (`visibility: ["app"]`) linked to this `ui://` View. */
  appTool<
    Input extends StandardSchemaWithJSON | undefined = undefined,
    Output extends StandardSchemaWithJSON | undefined = undefined,
  >(
    name: string,
    config: AppToolConfig<Input, Output>,
    handler: ToolCallback<Input>,
  ): RegisteredTool;
}

const STABLE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const UI_HOST_PATTERN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/u;
const WILDCARD_HTTPS_ORIGIN_PATTERN =
  /^https:\/\/\*\.([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)(?::(\d{1,5}))?$/u;

function createPresentationManifestSchema(allowLocalhost: boolean) {
  const originField = z
    .string()
    .refine(
      (value) => canonicalAppOrigin(value, allowLocalhost) !== null,
      allowLocalhost
        ? "expected a canonical https (or localhost http) origin"
        : "expected a canonical https origin",
    );

  const assetUrlField = z
    .string()
    .max(2048)
    .refine(
      (value) => canonicalAppAssetUrl(value, allowLocalhost) !== null,
      allowLocalhost
        ? "expected an https (or localhost http) URL without credentials"
        : "expected an https URL without credentials",
    );

  const hexColorField = z.string().regex(HEX_COLOR_PATTERN, "expected #RRGGBB");

  const paletteSchema = z
    .object({
      background: hexColorField,
      surface: hexColorField,
      border: hexColorField,
      text: hexColorField,
      textSecondary: hexColorField.optional(),
      text_secondary: hexColorField.optional(),
    })
    .strict()
    .refine(
      (value) =>
        (value.textSecondary !== undefined) !==
        (value.text_secondary !== undefined),
      "expected textSecondary (or text_secondary)",
    );

  const singleSchemeThemeSchema = z
    .object({
      colorScheme: z.enum(["light", "dark"]).optional(),
      color_scheme: z.enum(["light", "dark"]).optional(),
      background: hexColorField,
      surface: hexColorField,
      border: hexColorField,
      text: hexColorField,
      textSecondary: hexColorField.optional(),
      text_secondary: hexColorField.optional(),
    })
    .strict()
    .refine(
      (value) =>
        (value.colorScheme !== undefined) !==
          (value.color_scheme !== undefined) &&
        (value.textSecondary !== undefined) !==
          (value.text_secondary !== undefined),
      "expected colorScheme/color_scheme and textSecondary/text_secondary",
    );

  const dualThemeSchema = z
    .object({
      light: paletteSchema.optional(),
      dark: paletteSchema.optional(),
      defaultScheme: z.enum(["light", "dark"]).optional(),
      default_scheme: z.enum(["light", "dark"]).optional(),
    })
    .strict()
    .refine(
      (value) =>
        !(
          value.defaultScheme !== undefined &&
          value.default_scheme !== undefined
        ),
      "do not specify both defaultScheme and default_scheme",
    );

  const colorsSchema = z
    .object({
      accent: hexColorField.optional(),
      accentSoft: hexColorField.optional(),
      accent_soft: hexColorField.optional(),
      ink: hexColorField.optional(),
      surface: hexColorField.optional(),
    })
    .strict()
    .refine(
      (value) =>
        !(value.accentSoft !== undefined && value.accent_soft !== undefined),
      "do not specify both accentSoft and accent_soft",
    );

  const fontFamilyField = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(PLAIN_FONT_FAMILY_PATTERN, "expected a plain font-family list");

  const brandSchema = z
    .object({
      logoUrl: assetUrlField.optional(),
      logo_url: assetUrlField.optional(),
      logoDarkUrl: assetUrlField.optional(),
      logo_dark_url: assetUrlField.optional(),
      logoAlt: z.string().trim().min(1).max(120).optional(),
      logo_alt: z.string().trim().min(1).max(120).optional(),
      theme: z.union([dualThemeSchema, singleSchemeThemeSchema]).optional(),
      colors: colorsSchema.optional(),
      fontFamily: fontFamilyField.optional(),
      font_family: fontFamilyField.optional(),
    })
    .strict()
    .refine(
      (value) =>
        !(value.logoUrl !== undefined && value.logo_url !== undefined) &&
        !(
          value.logoDarkUrl !== undefined && value.logo_dark_url !== undefined
        ) &&
        !(value.logoAlt !== undefined && value.logo_alt !== undefined) &&
        !(value.fontFamily !== undefined && value.font_family !== undefined),
      "do not mix camelCase and snake_case duplicate keys in brand",
    );

  return z
    .object({
      productName: z.string().trim().min(1).max(80).optional(),
      product_name: z.string().trim().min(1).max(80).optional(),
      organizationName: z.string().trim().min(1).max(120).optional(),
      organization_name: z.string().trim().min(1).max(120).optional(),
      hubUrl: originField.nullable().optional(),
      hub_url: originField.nullable().optional(),
      brand: brandSchema.optional(),
    })
    .strict()
    .refine(
      (value) =>
        !(
          value.productName !== undefined && value.product_name !== undefined
        ) &&
        !(
          value.organizationName !== undefined &&
          value.organization_name !== undefined
        ) &&
        !(value.hubUrl !== undefined && value.hub_url !== undefined),
      "do not mix camelCase and snake_case duplicate keys in presentation manifest",
    );
}

/** Strict Zod schema (`zod@^4.2.0`) accepting camelCase or snake_case manifest/env configuration. */
export const McpAppPresentationManifestSchema =
  createPresentationManifestSchema(false);

const LocalhostPresentationManifestSchema =
  createPresentationManifestSchema(true);

export type McpAppPresentationManifestInput = z.infer<
  typeof McpAppPresentationManifestSchema
>;

export interface McpAppPresentationResolveInput {
  readonly productName?: string | null;
  readonly hubUrl?: string | null;
  readonly appOrigin?: string | null;
  readonly organization?: {
    readonly name?: string | null;
    readonly slug: string;
  };
  readonly project?: {
    readonly name: string;
    readonly slug: string;
  };
  readonly brand?: McpAppBrand;
  readonly manifest?: unknown;
  readonly manifestPresentation?: unknown;
}

export type McpAppPresentationInput =
  | McpAppPresentation
  | McpAppPresentationResolveInput;

export function parseAppPresentationManifest(
  value: unknown,
  options: { readonly allowLocalhostOrigins?: boolean } = {},
): McpAppPresentationManifestInput {
  const schema = options.allowLocalhostOrigins
    ? LocalhostPresentationManifestSchema
    : McpAppPresentationManifestSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new McpAppPresentationError(
      "presentation_invalid",
      `Invalid MCP App presentation manifest: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "manifest"} ${issue.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

function isResolvedPresentationShape(
  value: McpAppPresentationInput,
): value is McpAppPresentation {
  return (
    "schemaVersion" in value &&
    value.schemaVersion === 1 &&
    !("manifest" in value) &&
    !("manifestPresentation" in value) &&
    !("appOrigin" in value)
  );
}

function validateNamedEntity(
  label: string,
  name: string | null | undefined,
  slug: string,
): { readonly name: string; readonly slug: string } {
  const cleanSlug = slug.trim();
  const cleanName = (name ?? cleanSlug).trim();
  if (
    !cleanSlug ||
    cleanSlug.length > 120 ||
    /[\u0000-\u001f\u007f]/u.test(cleanSlug) ||
    !cleanName ||
    cleanName.length > 120 ||
    /[\u0000-\u001f\u007f]/u.test(cleanName)
  ) {
    throw new McpAppPresentationError(
      "presentation_invalid",
      `Invalid MCP App presentation ${label}`,
    );
  }
  return Object.freeze({ name: cleanName, slug: cleanSlug });
}

export function resolveAppPresentation(
  input?: McpAppPresentationInput,
  options: { readonly allowLocalhostOrigins?: boolean } = {},
): McpAppPresentation {
  if (input === undefined) return NEUTRAL_APP_PRESENTATION;
  const allowLocalhost = options.allowLocalhostOrigins ?? false;

  if (isResolvedPresentationShape(input)) {
    const manifestCandidate: Record<string, unknown> = {
      ...(input.productName !== null ? { productName: input.productName } : {}),
      ...(input.hubUrl !== null ? { hubUrl: input.hubUrl } : {}),
      ...(input.brand !== undefined ? { brand: input.brand } : {}),
    };
    parseAppPresentationManifest(manifestCandidate, {
      allowLocalhostOrigins: allowLocalhost,
    });
    const organization = input.organization
      ? validateNamedEntity(
          "organization",
          input.organization.name,
          input.organization.slug,
        )
      : undefined;
    const project = input.project
      ? validateNamedEntity("project", input.project.name, input.project.slug)
      : undefined;
    const sanitized = sanitizeAppPresentationPayload(input, {
      allowLocalhostOrigins: allowLocalhost,
    });
    return Object.freeze({
      ...sanitized,
      ...(organization ? { organization } : {}),
      ...(project ? { project } : {}),
    });
  }

  const rawManifest =
    input.manifest !== undefined ? input.manifest : input.manifestPresentation;
  const manifest =
    rawManifest !== undefined
      ? parseAppPresentationManifest(rawManifest, {
          allowLocalhostOrigins: allowLocalhost,
        })
      : undefined;

  if (input.brand !== undefined) {
    parseAppPresentationManifest(
      { brand: input.brand },
      { allowLocalhostOrigins: allowLocalhost },
    );
  }

  if (
    input.productName !== undefined &&
    input.productName !== null &&
    (!input.productName.trim() ||
      input.productName.trim().length > 80 ||
      /[\u0000-\u001f\u007f]/u.test(input.productName))
  ) {
    throw new McpAppPresentationError(
      "presentation_invalid",
      "Invalid MCP App presentation productName",
    );
  }

  if (input.hubUrl !== undefined && input.hubUrl !== null) {
    if (canonicalAppOrigin(input.hubUrl, allowLocalhost) === null) {
      throw new McpAppPresentationError(
        "presentation_invalid",
        "Invalid MCP App presentation hubUrl",
      );
    }
  }

  const fallbackOrigin =
    typeof input.appOrigin === "string"
      ? canonicalAppOrigin(input.appOrigin, allowLocalhost)
      : null;

  const project = input.project
    ? validateNamedEntity("project", input.project.name, input.project.slug)
    : undefined;
  const manifestOrgName =
    manifest?.organizationName ?? manifest?.organization_name;
  const organization = input.organization
    ? validateNamedEntity(
        "organization",
        manifestOrgName ?? input.organization.name,
        input.organization.slug,
      )
    : undefined;

  const manifestProductName = manifest?.productName ?? manifest?.product_name;
  const resolvedProductName =
    input.productName !== undefined
      ? input.productName?.trim() || null
      : (manifestProductName ?? project?.name ?? null);

  const hasManifestHub =
    manifest !== undefined &&
    (manifest.hubUrl !== undefined || manifest.hub_url !== undefined);
  const manifestHubUrl = manifest?.hubUrl ?? manifest?.hub_url ?? null;
  const resolvedHubUrl =
    input.hubUrl !== undefined
      ? input.hubUrl
      : hasManifestHub
        ? manifestHubUrl
        : fallbackOrigin;

  const normalized = sanitizeAppPresentationPayload(
    {
      productName: resolvedProductName,
      hubUrl: resolvedHubUrl,
      brand: input.brand ?? manifest?.brand,
    },
    { allowLocalhostOrigins: allowLocalhost },
  );

  return Object.freeze({
    schemaVersion: 1 as const,
    productName: normalized.productName,
    hubUrl: normalized.hubUrl,
    ...(organization ? { organization } : {}),
    ...(project ? { project } : {}),
    ...(normalized.brand ? { brand: normalized.brand } : {}),
  });
}

export function parseAppPresentationEnv(
  rawJson: string | undefined,
  options: { readonly allowLocalhostOrigins?: boolean } = {},
): McpAppPresentation | undefined {
  if (rawJson === undefined || rawJson.trim() === "") return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawJson);
  } catch {
    throw new McpAppPresentationError(
      "presentation_invalid",
      "MCP App presentation environment JSON could not be parsed",
    );
  }
  const manifest = parseAppPresentationManifest(decoded, options);
  return resolveAppPresentation({ manifest }, options);
}

/** Deduplicated origins needed to load `brand.logoUrl` and `brand.logoDarkUrl`. */
export function mcpAppPresentationOrigins(
  presentation: McpAppPresentation | undefined,
): string[] {
  if (!presentation?.brand) return [];
  const urls = [presentation.brand.logoUrl, presentation.brand.logoDarkUrl];
  return [
    ...new Set(
      urls
        .filter(
          (url): url is string => typeof url === "string" && url.length > 0,
        )
        .map((url) => new URL(url).origin),
    ),
  ];
}

/**
 * Serialize JSON safely for embedding inside an HTML `<script>` element:
 * escapes `<`, `>`, `&` (preventing `</script>`, `<!--`, and `-->` breakouts)
 * and U+2028 / U+2029 JS line terminators.
 */
export function scriptSafeJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError("MCP App presentation must be JSON-serializable");
  }
  return json
    .replace(/</gu, "\\u003c")
    .replace(/>/gu, "\\u003e")
    .replace(/&/gu, "\\u0026")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}

/**
 * Inject `presentation` into a compiled single-file View HTML string.
 *
 * When `mode` is `"placeholder"` (default), `MCP_APP_PRESENTATION_PLACEHOLDER`
 * MUST occur exactly once inside the HTML; 0 or >1 occurrences throw `McpAppPresentationError`.
 * When `mode` is `"auto"`, 1 occurrence is replaced, >1 throws, and 0 occurrences leaves static HTML untouched.
 */
export function injectAppPresentation(
  html: string,
  presentation: McpAppPresentation,
  options: { readonly mode?: "placeholder" | "auto" } = {},
): string {
  const mode = options.mode ?? "placeholder";
  const first = html.indexOf(MCP_APP_PRESENTATION_PLACEHOLDER);
  if (first === -1) {
    if (mode === "auto") return html;
    throw new McpAppPresentationError(
      "presentation_placeholder_invalid",
      "MCP App HTML is missing __MCP_APP_PRESENTATION__ placeholder",
    );
  }
  if (html.indexOf(MCP_APP_PRESENTATION_PLACEHOLDER, first + 1) !== -1) {
    throw new McpAppPresentationError(
      "presentation_placeholder_invalid",
      "MCP App HTML contains multiple __MCP_APP_PRESENTATION__ placeholders",
    );
  }
  const safePresentation = resolveAppPresentation(presentation, {
    allowLocalhostOrigins: true,
  });
  return (
    html.slice(0, first) +
    scriptSafeJson(safePresentation) +
    html.slice(first + MCP_APP_PRESENTATION_PLACEHOLDER.length)
  );
}

/** Schema for explicit `request_id` UUID arguments on idempotent UI mutation tools. */
export const requestIdFieldSchema = z
  .string()
  .uuid()
  .describe(
    "Fresh UUID for a new change. Reuse the exact UUID and arguments when retrying an uncertain write.",
  );

/** Standard domain refusal when a `request_id` is reused with mutated arguments. */
export function idempotencyConflictResult(
  field = "request_id",
): CallToolResult {
  return errorResult(
    `idempotency_conflict: This ${field} was already used with different arguments.`,
    `Mint a fresh UUID in ${field} for a new change, or reload current state.`,
  );
}

export function assertMcpAppUri(uri: string): McpAppUri {
  if (typeof uri !== "string" || !uri.startsWith("ui://")) {
    throw new TypeError(
      `MCP App URI must start with 'ui://', received '${String(uri)}'`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new TypeError(`Invalid MCP App URI '${uri}'`);
  }
  const segments = parsed.pathname.split("/").slice(1);
  if (
    parsed.protocol !== "ui:" ||
    !parsed.hostname ||
    !UI_HOST_PATTERN.test(parsed.hostname) ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[\u0000-\u001f\u007f\\\s]/u.test(segment),
    ) ||
    !parsed.pathname.endsWith(".html") ||
    parsed.href !== uri
  ) {
    throw new TypeError(
      `MCP App URI '${uri}' must be a canonical 'ui://<namespace>/<view>.html' URI without query, hash, or path traversal`,
    );
  }
  return uri as McpAppUri;
}

function validateCspDomain(
  value: string,
  allowWildcardSubdomain: boolean,
  allowLocalhost: boolean,
): string {
  if (allowWildcardSubdomain) {
    const match = WILDCARD_HTTPS_ORIGIN_PATTERN.exec(value);
    if (match) {
      const port = match[2];
      if (port !== undefined) {
        const numeric = Number(port);
        if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) {
          throw new TypeError(`Invalid port in MCP App CSP origin '${value}'`);
        }
      }
      return value;
    }
  }
  const origin = canonicalAppOrigin(value, allowLocalhost);
  if (!origin) {
    throw new TypeError(
      `MCP App CSP domain '${value}' must be a canonical https origin${allowLocalhost ? " (or localhost http origin)" : ""}`,
    );
  }
  return origin;
}

function normalizeOriginList(
  values: readonly string[] | undefined,
  allowWildcardSubdomain: boolean,
  allowLocalhost: boolean,
): string[] {
  if (!values || values.length === 0) return [];
  return [
    ...new Set(
      values.map((item) =>
        validateCspDomain(item, allowWildcardSubdomain, allowLocalhost),
      ),
    ),
  ];
}

function normalizeScopes(scopes: readonly string[] | undefined): string[] {
  const result = [...new Set((scopes ?? []).map((scope) => scope.trim()))];
  if (result.some((scope) => !scope || /\s/u.test(scope))) {
    throw new TypeError("MCP App scopes must be non-empty tokens");
  }
  return result;
}

function validateToolSafety(
  toolName: string,
  risk: ChumboCapabilityRisk,
  idempotent: boolean,
  annotations: ToolAnnotations | undefined,
  defaultTitle: string | undefined,
): ToolAnnotations {
  if (!["read", "write", "destructive"].includes(risk)) {
    throw new TypeError(
      `Tool '${toolName}' risk must be 'read', 'write', or 'destructive'`,
    );
  }
  const readOnly = annotations?.readOnlyHint;
  const destructive = annotations?.destructiveHint;
  if (risk === "read" && (readOnly === false || destructive === true)) {
    throw new TypeError(
      `Read tool '${toolName}' has conflicting MCP safety annotations`,
    );
  }
  if (risk !== "read" && readOnly === true) {
    throw new TypeError(
      `Mutating tool '${toolName}' cannot be annotated as read-only`,
    );
  }
  if (risk === "destructive" && destructive === false) {
    throw new TypeError(
      `Destructive tool '${toolName}' cannot disable destructiveHint`,
    );
  }
  if (
    annotations?.idempotentHint !== undefined &&
    annotations.idempotentHint !== idempotent
  ) {
    throw new TypeError(
      `Tool '${toolName}' idempotent option conflicts with annotations.idempotentHint`,
    );
  }
  const title = annotations?.title ?? defaultTitle;
  return {
    ...annotations,
    ...(title !== undefined ? { title } : {}),
    readOnlyHint: risk === "read",
    destructiveHint: risk === "destructive",
    idempotentHint: idempotent,
  };
}

/** Low-level `_meta` helper for attaching a `ui://` View to `defineCapability` or raw `registerTool`. */
export function mcpAppToolMeta(
  resourceUri: McpAppUri,
  visibility: readonly McpAppToolVisibility[],
): McpAppToolMeta {
  const uri = assertMcpAppUri(resourceUri);
  if (!Array.isArray(visibility) || visibility.length === 0) {
    throw new TypeError("MCP App tool visibility must be a non-empty array");
  }
  const deduped: McpAppToolVisibility[] = [];
  for (const entry of visibility) {
    if (entry !== "model" && entry !== "app") {
      throw new TypeError(
        `MCP App tool visibility must contain only 'model' or 'app', received '${String(entry)}'`,
      );
    }
    if (!deduped.includes(entry)) deduped.push(entry);
  }
  return {
    ui: {
      resourceUri: uri,
      visibility: deduped,
    },
    [MCP_APP_RESOURCE_URI_META_KEY]: uri,
  };
}

/** Low-level `_meta` builder for `ui://` Resources with auto-derived presentation CSP domains. */
export function mcpAppResourceMeta(options: {
  readonly csp?: McpAppCspInput;
  readonly presentation?: McpAppPresentation;
  readonly permissions?: McpAppPermissions;
  readonly prefersBorder?: boolean;
  readonly domain?: string;
}): McpAppResourceMeta {
  const allowLocalhost = options.csp?.allowLocalhostOrigins ?? false;
  const connectDomains = normalizeOriginList(
    options.csp?.connectOrigins,
    false,
    allowLocalhost,
  );
  const explicitResourceDomains = normalizeOriginList(
    options.csp?.resourceOrigins,
    true,
    allowLocalhost,
  );
  const logoOrigins = mcpAppPresentationOrigins(options.presentation);
  const resourceDomains = [
    ...new Set([...explicitResourceDomains, ...logoOrigins]),
  ];
  const frameDomains = normalizeOriginList(
    options.csp?.frameOrigins,
    false,
    allowLocalhost,
  );
  const baseUriDomains = normalizeOriginList(
    options.csp?.baseUriOrigins,
    false,
    allowLocalhost,
  );

  if (options.domain !== undefined) {
    const trimmed = options.domain.trim();
    if (
      !trimmed ||
      trimmed.includes("/") ||
      trimmed.includes(":") ||
      /\s/u.test(trimmed)
    ) {
      throw new TypeError(
        "MCP App resource domain must be a bare hostname without scheme or path",
      );
    }
  }

  const csp: McpAppCsp = {
    ...(connectDomains.length > 0 ? { connectDomains } : {}),
    ...(resourceDomains.length > 0 ? { resourceDomains } : {}),
    ...(frameDomains.length > 0 ? { frameDomains } : {}),
    ...(baseUriDomains.length > 0 ? { baseUriDomains } : {}),
  };

  return {
    ui: {
      csp,
      ...(options.permissions ? { permissions: options.permissions } : {}),
      ...(options.domain ? { domain: options.domain.trim() } : {}),
      prefersBorder: options.prefersBorder ?? true,
    },
  };
}

/** True when a discovered tool declares `visibility` containing `"app"` and NOT `"model"`. */
export function isMcpAppOnlyTool(tool: {
  readonly _meta?: Readonly<Record<string, unknown>>;
}): boolean {
  const ui = tool._meta?.ui;
  if (typeof ui !== "object" || ui === null || Array.isArray(ui)) return false;
  const visibility = (ui as Record<string, unknown>).visibility;
  if (!Array.isArray(visibility) || visibility.length === 0) return false;
  return visibility.includes("app") && !visibility.includes("model");
}

/** Validate and freeze a reusable `ui://` MCP App definition. */
export function defineMcpApp(definition: McpAppDefinition): DefinedMcpApp {
  if (!STABLE_ID_PATTERN.test(definition.name)) {
    throw new TypeError(
      "MCP App name must be a stable lowercase identifier using dots, dashes, or underscores",
    );
  }
  const uri = assertMcpAppUri(definition.uri);
  if (!definition.description || !definition.description.trim()) {
    throw new TypeError("MCP App description is required");
  }
  if (
    typeof definition.title !== "function" &&
    (!definition.title || !definition.title.trim())
  ) {
    throw new TypeError("MCP App title must be a non-empty string or function");
  }
  if (
    typeof definition.html !== "string" &&
    typeof definition.html !== "function"
  ) {
    throw new TypeError(
      "MCP App html must be an HTML string or reader function",
    );
  }
  const scopes = Object.freeze(normalizeScopes(definition.scopes));
  // Eagerly validate baseline CSP and domain metadata at definition time:
  mcpAppResourceMeta({
    csp: definition.csp,
    permissions: definition.permissions,
    prefersBorder: definition.prefersBorder,
    domain: definition.domain,
  });

  return Object.freeze({
    ...definition,
    uri,
    scopes,
  });
}

function mergeCspInputs(
  base: McpAppCspInput | undefined,
  override: McpAppCspInput | undefined,
): McpAppCspInput | undefined {
  if (!base && !override) return undefined;
  return {
    connectOrigins: [
      ...(base?.connectOrigins ?? []),
      ...(override?.connectOrigins ?? []),
    ],
    resourceOrigins: [
      ...(base?.resourceOrigins ?? []),
      ...(override?.resourceOrigins ?? []),
    ],
    frameOrigins: [
      ...(base?.frameOrigins ?? []),
      ...(override?.frameOrigins ?? []),
    ],
    baseUriOrigins: [
      ...(base?.baseUriOrigins ?? []),
      ...(override?.baseUriOrigins ?? []),
    ],
    allowLocalhostOrigins:
      (base?.allowLocalhostOrigins ?? false) ||
      (override?.allowLocalhostOrigins ?? false),
  };
}

function scopedServerTarget(
  server: SupabaseMcpServer | McpServer,
  scopes: readonly string[],
): SupabaseMcpServer | McpServer {
  if (scopes.length === 0) return server;
  const candidate = server as Partial<SupabaseMcpServer>;
  if (typeof candidate.withScopes !== "function") {
    throw new TypeError(
      "Cannot enforce MCP App scopes on a bare McpServer without withScopes(). Use createSupabaseMcp or ctx.chumbo.instrument(server).",
    );
  }
  return candidate.withScopes(scopes);
}

/**
 * Register the `ui://` HTML Resource once and return scope-aware `openTool` and `appTool`
 * builders bound to its `resourceUri`.
 */
export function registerMcpApp(
  server: SupabaseMcpServer | McpServer,
  app: DefinedMcpApp,
  options: RegisterMcpAppOptions = {},
): RegisteredMcpApp {
  const presentation = options.presentation
    ? resolveAppPresentation(options.presentation, {
        allowLocalhostOrigins:
          (app.csp?.allowLocalhostOrigins ?? false) ||
          (options.csp?.allowLocalhostOrigins ?? false) ||
          Boolean(
            options.presentation.hubUrl?.startsWith("http://localhost") ||
            options.presentation.hubUrl?.startsWith("http://127.0.0.1") ||
            options.presentation.hubUrl?.startsWith("http://[::1]"),
          ),
      })
    : NEUTRAL_APP_PRESENTATION;

  const mergedCsp = mergeCspInputs(app.csp, options.csp);
  const resourceMeta = mcpAppResourceMeta({
    csp: mergedCsp,
    presentation,
    permissions: app.permissions,
    prefersBorder: app.prefersBorder,
    domain: app.domain,
  });

  const appScopes = normalizeScopes(options.scopes ?? app.scopes);
  const resolvedTitle =
    typeof app.title === "function" ? app.title(presentation) : app.title;
  if (!resolvedTitle || !resolvedTitle.trim()) {
    throw new TypeError(`MCP App '${app.name}' resolved an empty title`);
  }

  const injectMode = options.injectPresentation ?? "auto";
  const rawMetaRecord = resourceMeta as unknown as Record<string, unknown>;

  const resourceTarget = scopedServerTarget(server, appScopes);
  const resource = resourceTarget.registerResource(
    app.name,
    app.uri,
    {
      title: resolvedTitle,
      description: app.description,
      mimeType: MCP_APP_MIME_TYPE,
      _meta: rawMetaRecord,
    },
    async (uri: URL) => {
      const rawHtml =
        typeof app.html === "function"
          ? await app.html({ uri, presentation })
          : app.html;
      const text =
        injectMode === "none"
          ? rawHtml
          : injectAppPresentation(rawHtml, presentation, { mode: injectMode });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: MCP_APP_MIME_TYPE,
            text,
            _meta: rawMetaRecord,
          },
        ],
      };
    },
  );

  return {
    uri: app.uri,
    resource,
    resourceMeta,

    openTool<
      Input extends StandardSchemaWithJSON | undefined = undefined,
      Output extends StandardSchemaWithJSON | undefined = undefined,
    >(
      name: string,
      config: OpenToolConfig<Input, Output>,
      handler: ToolCallback<Input>,
    ): RegisteredTool {
      if (!STABLE_ID_PATTERN.test(name)) {
        throw new TypeError(
          `MCP App tool name '${name}' must be a stable lowercase identifier`,
        );
      }
      if (!config.description || !config.description.trim()) {
        throw new TypeError(`Tool '${name}' description is required`);
      }
      const risk = config.risk ?? "read";
      const idempotent = config.idempotent ?? risk === "read";
      const annotations = validateToolSafety(
        name,
        risk,
        idempotent,
        config.annotations,
        config.title,
      );
      const visibility = config.visibility ?? (["model"] as const);
      if (!visibility.includes("model")) {
        throw new TypeError(
          `openTool '${name}' visibility must include 'model'`,
        );
      }
      const toolScopes =
        config.scopes !== undefined
          ? normalizeScopes(config.scopes)
          : appScopes;
      const target = scopedServerTarget(server, toolScopes);
      const meta = mcpAppToolMeta(app.uri, visibility);

      return target.registerTool(
        name,
        {
          ...(config.title ? { title: config.title } : {}),
          description: config.description,
          ...(config.inputSchema ? { inputSchema: config.inputSchema } : {}),
          ...(config.outputSchema ? { outputSchema: config.outputSchema } : {}),
          annotations,
          _meta: {
            ...config._meta,
            ...meta,
          },
        },
        handler,
      );
    },

    appTool<
      Input extends StandardSchemaWithJSON | undefined = undefined,
      Output extends StandardSchemaWithJSON | undefined = undefined,
    >(
      name: string,
      config: AppToolConfig<Input, Output>,
      handler: ToolCallback<Input>,
    ): RegisteredTool {
      if (!STABLE_ID_PATTERN.test(name)) {
        throw new TypeError(
          `MCP App tool name '${name}' must be a stable lowercase identifier`,
        );
      }
      if (!config.description || !config.description.trim()) {
        throw new TypeError(`Tool '${name}' description is required`);
      }
      if (
        config.risk !== "read" &&
        appScopes.length > 0 &&
        config.scopes === undefined
      ) {
        throw new TypeError(
          `Mutating appTool '${name}' on scoped app '${app.name}' must declare explicit scopes (visibility: ['app'] is presentation metadata, not authorization).`,
        );
      }
      const idempotent = config.idempotent ?? config.risk === "read";
      const annotations = validateToolSafety(
        name,
        config.risk,
        idempotent,
        config.annotations,
        config.title,
      );
      const toolScopes =
        config.scopes !== undefined
          ? normalizeScopes(config.scopes)
          : appScopes;
      const target = scopedServerTarget(server, toolScopes);
      const meta = mcpAppToolMeta(app.uri, ["app"]);

      return target.registerTool(
        name,
        {
          ...(config.title ? { title: config.title } : {}),
          description: config.description,
          ...(config.inputSchema ? { inputSchema: config.inputSchema } : {}),
          ...(config.outputSchema ? { outputSchema: config.outputSchema } : {}),
          annotations,
          _meta: {
            ...config._meta,
            ...meta,
          },
        },
        handler,
      );
    },
  };
}
