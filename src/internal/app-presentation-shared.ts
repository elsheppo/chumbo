export const MCP_APP_PRESENTATION_SCRIPT_ID = "mcp-app-presentation" as const;

export interface McpAppThemePalette {
  readonly background: string;
  readonly surface: string;
  readonly border: string;
  readonly text: string;
  readonly textSecondary: string;
}

export interface McpAppBrandColors {
  readonly accent?: string;
  readonly accentSoft?: string;
  readonly ink?: string;
  readonly surface?: string;
}

export interface McpAppBrand {
  /** HTTPS URL without credentials; its origin is auto-added to `_meta.ui.csp.resourceDomains`. */
  readonly logoUrl?: string;
  /** Optional dark-mode logo HTTPS URL; its origin is auto-added to `_meta.ui.csp.resourceDomains`. */
  readonly logoDarkUrl?: string;
  readonly logoAlt?: string;
  /** Explicit light and/or dark surface tokens (supports single locked theme or host-synced pair). */
  readonly theme?: {
    readonly light?: McpAppThemePalette;
    readonly dark?: McpAppThemePalette;
    readonly defaultScheme?: "light" | "dark";
  };
  readonly colors?: McpAppBrandColors;
  /** Plain host-installed font-family stack (`/^[A-Za-z0-9 ,'"-]+$/u`). Never loads external font URLs. */
  readonly fontFamily?: string;
}

export interface McpAppPresentation {
  readonly schemaVersion: 1;
  /** Product display name (e.g. `"Marketing Hub"`); `null` when neutral. */
  readonly productName: string | null;
  /** Canonical web app origin (e.g. `"https://app.example.com"`) for deep links; `null` disables links. */
  readonly hubUrl: string | null;
  readonly organization?: { readonly name: string; readonly slug: string };
  readonly project?: { readonly name: string; readonly slug: string };
  readonly brand?: McpAppBrand;
}

export const NEUTRAL_APP_PRESENTATION: McpAppPresentation = Object.freeze({
  schemaVersion: 1,
  productName: null,
  hubUrl: null,
});

export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/u;
export const PLAIN_FONT_FAMILY_PATTERN = /^[A-Za-z0-9 ,'"-]+$/u;

export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

export function isAllowedAppUrlScheme(
  url: URL,
  allowLocalhost = false,
): boolean {
  if (url.protocol === "https:") return true;
  return (
    allowLocalhost &&
    url.protocol === "http:" &&
    isLoopbackHostname(url.hostname)
  );
}

export function canonicalAppOrigin(
  value: string,
  allowLocalhost = false,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    !isAllowedAppUrlScheme(parsed, allowLocalhost) ||
    parsed.username ||
    parsed.password ||
    parsed.origin !== value
  ) {
    return null;
  }
  return parsed.origin;
}

export function canonicalAppAssetUrl(
  value: string,
  allowLocalhost = false,
): string | null {
  if (!value || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    !isAllowedAppUrlScheme(parsed, allowLocalhost) ||
    parsed.username ||
    parsed.password
  ) {
    return null;
  }
  return parsed.toString();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanBoundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > maxLength ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function sanitizePalette(value: unknown): McpAppThemePalette | undefined {
  if (!isPlainObject(value)) return undefined;
  const background = value.background;
  const surface = value.surface;
  const border = value.border;
  const text = value.text;
  const textSecondary = value.textSecondary ?? value.text_secondary;
  if (
    typeof background !== "string" ||
    !HEX_COLOR_PATTERN.test(background) ||
    typeof surface !== "string" ||
    !HEX_COLOR_PATTERN.test(surface) ||
    typeof border !== "string" ||
    !HEX_COLOR_PATTERN.test(border) ||
    typeof text !== "string" ||
    !HEX_COLOR_PATTERN.test(text) ||
    typeof textSecondary !== "string" ||
    !HEX_COLOR_PATTERN.test(textSecondary)
  ) {
    return undefined;
  }
  return Object.freeze({
    background,
    surface,
    border,
    text,
    textSecondary,
  });
}

function sanitizeColors(value: unknown): McpAppBrandColors | undefined {
  if (!isPlainObject(value)) return undefined;
  const accent =
    typeof value.accent === "string" && HEX_COLOR_PATTERN.test(value.accent)
      ? value.accent
      : undefined;
  const rawSoft = value.accentSoft ?? value.accent_soft;
  const accentSoft =
    typeof rawSoft === "string" && HEX_COLOR_PATTERN.test(rawSoft)
      ? rawSoft
      : undefined;
  const ink =
    typeof value.ink === "string" && HEX_COLOR_PATTERN.test(value.ink)
      ? value.ink
      : undefined;
  const surface =
    typeof value.surface === "string" && HEX_COLOR_PATTERN.test(value.surface)
      ? value.surface
      : undefined;
  if (!accent && !accentSoft && !ink && !surface) return undefined;
  return Object.freeze({
    ...(accent ? { accent } : {}),
    ...(accentSoft ? { accentSoft } : {}),
    ...(ink ? { ink } : {}),
    ...(surface ? { surface } : {}),
  });
}

function sanitizeTheme(
  value: unknown,
): NonNullable<McpAppBrand["theme"]> | undefined {
  if (!isPlainObject(value)) return undefined;
  // Support single-palette manifest shape (`{ color_scheme: "light" | "dark", background, ... }`)
  // as well as `{ light?, dark?, defaultScheme? }`.
  const singleScheme = value.color_scheme ?? value.colorScheme;
  if (singleScheme === "light" || singleScheme === "dark") {
    const palette = sanitizePalette(value);
    if (palette) {
      return Object.freeze({
        [singleScheme]: palette,
        defaultScheme: singleScheme,
      });
    }
  }
  const light = sanitizePalette(value.light);
  const dark = sanitizePalette(value.dark);
  const rawDefault = value.defaultScheme ?? value.default_scheme;
  const defaultScheme =
    rawDefault === "light" || rawDefault === "dark" ? rawDefault : undefined;
  if (!light && !dark && !defaultScheme) return undefined;
  return Object.freeze({
    ...(light ? { light } : {}),
    ...(dark ? { dark } : {}),
    ...(defaultScheme ? { defaultScheme } : {}),
  });
}

function sanitizeBrand(
  value: unknown,
  allowLocalhost: boolean,
): McpAppBrand | undefined {
  if (!isPlainObject(value)) return undefined;
  const rawLogo = value.logoUrl ?? value.logo_url;
  const logoUrl =
    typeof rawLogo === "string"
      ? (canonicalAppAssetUrl(rawLogo, allowLocalhost) ?? undefined)
      : undefined;
  const rawLogoDark = value.logoDarkUrl ?? value.logo_dark_url;
  const logoDarkUrl =
    typeof rawLogoDark === "string"
      ? (canonicalAppAssetUrl(rawLogoDark, allowLocalhost) ?? undefined)
      : undefined;
  const logoAlt =
    cleanBoundedText(value.logoAlt ?? value.logo_alt, 120) ?? undefined;
  const theme = sanitizeTheme(value.theme);
  const colors = sanitizeColors(value.colors);
  const rawFont = value.fontFamily ?? value.font_family;
  const trimmedFont = typeof rawFont === "string" ? rawFont.trim() : undefined;
  const fontFamily =
    trimmedFont &&
    trimmedFont.length <= 200 &&
    PLAIN_FONT_FAMILY_PATTERN.test(trimmedFont)
      ? trimmedFont
      : undefined;

  if (
    !logoUrl &&
    !logoDarkUrl &&
    !logoAlt &&
    !theme &&
    !colors &&
    !fontFamily
  ) {
    return undefined;
  }
  return Object.freeze({
    ...(logoUrl ? { logoUrl } : {}),
    ...(logoDarkUrl ? { logoDarkUrl } : {}),
    ...(logoAlt ? { logoAlt } : {}),
    ...(theme ? { theme } : {}),
    ...(colors ? { colors } : {}),
    ...(fontFamily ? { fontFamily } : {}),
  });
}

function sanitizeNamedSlug(
  value: unknown,
): { readonly name: string; readonly slug: string } | undefined {
  if (!isPlainObject(value)) return undefined;
  const name = cleanBoundedText(value.name, 120);
  const slug = cleanBoundedText(value.slug, 120);
  if (!name || !slug) return undefined;
  return Object.freeze({ name, slug });
}

/**
 * Sanitize an untrusted JSON-decoded presentation payload without importing Zod.
 * Invalid colors, fonts, or URLs are dropped rather than trusted in DOM styles or links.
 */
export function sanitizeAppPresentationPayload(
  raw: unknown,
  options: { readonly allowLocalhostOrigins?: boolean } = {},
): McpAppPresentation {
  if (!isPlainObject(raw)) return NEUTRAL_APP_PRESENTATION;
  const allowLocalhost = options.allowLocalhostOrigins ?? true;
  const productName = cleanBoundedText(raw.productName ?? raw.product_name, 80);
  const rawHub = raw.hubUrl ?? raw.hub_url;
  const hubUrl =
    typeof rawHub === "string"
      ? canonicalAppOrigin(rawHub, allowLocalhost)
      : null;
  const organization = sanitizeNamedSlug(raw.organization);
  const project = sanitizeNamedSlug(raw.project);
  const brand = sanitizeBrand(raw.brand, allowLocalhost);

  return Object.freeze({
    schemaVersion: 1 as const,
    productName,
    hubUrl,
    ...(organization ? { organization } : {}),
    ...(project ? { project } : {}),
    ...(brand ? { brand } : {}),
  });
}

/**
 * Safely construct an "Open in <productName>" deep link on `presentation.hubUrl`.
 *
 * Security invariants:
 * - Returns `null` when `presentation?.hubUrl` is null or absent.
 * - Rejects paths that do not start with a single `/` (blocks `//evil.com`, `https://...`,
 *   `javascript:...`, backslashes, and ASCII control characters).
 * - Verifies `resolved.origin === hubOrigin` before returning.
 */
export function buildHubUrl(
  presentation: Pick<McpAppPresentation, "hubUrl"> | null | undefined,
  path = "/",
  params?: Readonly<
    Record<string, string | number | boolean | null | undefined>
  >,
): string | null {
  if (!presentation?.hubUrl) return null;
  let base: URL;
  try {
    base = new URL(presentation.hubUrl);
  } catch {
    throw new TypeError(
      "presentation.hubUrl must be a canonical origin without credentials",
    );
  }
  if (
    !isAllowedAppUrlScheme(base, true) ||
    base.username ||
    base.password ||
    base.origin !== presentation.hubUrl
  ) {
    throw new TypeError(
      "presentation.hubUrl must be a canonical origin without credentials",
    );
  }
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    throw new TypeError(
      "Hub deep-link path must be a root-relative path starting with '/'",
    );
  }
  const resolved = new URL(path, base.origin);
  if (resolved.origin !== base.origin) {
    throw new TypeError(
      "Hub deep-link path escaped the configured hubUrl origin",
    );
  }
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        resolved.searchParams.set(key, String(value));
      }
    }
  }
  return resolved.toString();
}
