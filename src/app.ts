import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import {
  buildHubUrl,
  MCP_APP_PRESENTATION_SCRIPT_ID,
  NEUTRAL_APP_PRESENTATION,
  sanitizeAppPresentationPayload,
  type McpAppBrand,
  type McpAppBrandColors,
  type McpAppPresentation,
  type McpAppThemePalette,
} from "./internal/app-presentation-shared.js";

export {
  buildHubUrl,
  MCP_APP_PRESENTATION_SCRIPT_ID,
  NEUTRAL_APP_PRESENTATION,
  type McpAppBrand,
  type McpAppBrandColors,
  type McpAppPresentation,
  type McpAppThemePalette,
};

const DEFAULT_INLINE_HEIGHT = 560;
const DEFAULT_MIN_INLINE_HEIGHT = 360;
const DEFAULT_MAX_INLINE_HEIGHT = 720;
const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
const WORKSPACE_STYLE_ID = "__supa-mcp-app-workspace";

export const DEFINITIVE_REFUSAL_CODES = Object.freeze([
  "validation_failed",
  "invalid_input",
  "invalid_ref",
  "invalid_cursor",
  "not_permitted",
  "permission_denied",
  "not_found",
  "state_changed",
  "conflict",
  "idempotency_conflict",
] as const);

const WORKSPACE_CSS = `
html[data-supa-mcp-layout="workspace"] {
  height: var(--supa-mcp-app-height, 560px);
  min-height: 0;
  overflow: hidden;
}

html[data-supa-mcp-layout="workspace"] body {
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

[data-supa-mcp-workspace] {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding-block-start: calc(var(--supa-mcp-safe-top, 0px) + var(--supa-mcp-app-padding-block, 20px));
  padding-inline-end: calc(var(--supa-mcp-safe-right, 0px) + var(--supa-mcp-app-padding-inline, 20px));
  padding-block-end: calc(var(--supa-mcp-safe-bottom, 0px) + var(--supa-mcp-app-padding-block, 20px));
  padding-inline-start: calc(var(--supa-mcp-safe-left, 0px) + var(--supa-mcp-app-padding-inline, 20px));
}

[data-supa-mcp-scroll] {
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

[data-supa-mcp-workspace][data-supa-mcp-scroll-fallback="true"] {
  overflow: auto;
}
`;

export interface SupaMcpAppInfo {
  name: string;
  version: string;
}

export type McpAppHostContext = NonNullable<ReturnType<App["getHostContext"]>>;
export type McpAppDisplayMode = NonNullable<McpAppHostContext["displayMode"]>;
export type McpAppCapabilities = NonNullable<
  ConstructorParameters<typeof App>[1]
>;

export interface CreateAppWorkspaceOptions {
  /** Root element that should occupy the stable MCP App viewport. */
  root: HTMLElement;
  /** Preferred inline height before the host's own maximum is applied. */
  inlineHeight?: number;
  /** Lower bound for the preferred inline height when the host permits it. */
  minInlineHeight?: number;
  /** Upper bound for the preferred inline height. */
  maxInlineHeight?: number;
  /** Additional MCP App capabilities to advertise during initialization. */
  capabilities?: McpAppCapabilities;
  /** Automatically apply server-injected presentation CSS tokens. Defaults to `true`. */
  applyPresentation?: boolean;
}

export interface AppWorkspace {
  /** The official MCP Apps client. Register event handlers before connect(). */
  app: App;
  /** Sanitized tenant presentation injected into the HTML document. */
  readonly presentation: McpAppPresentation;
  /** Construct an origin-locked deep link onto `presentation.hubUrl` (or `null` when unconfigured). */
  hubUrl: (
    path?: string,
    params?: Readonly<
      Record<string, string | number | boolean | null | undefined>
    >,
  ) => string | null;
  /** Connect to the host, apply its context, and request one stable viewport. */
  connect: (...args: Parameters<App["connect"]>) => Promise<void>;
  /** Latest merged host context, including partial context updates. */
  getHostContext: () => McpAppHostContext | undefined;
  /** Whether the current host advertises fullscreen support. */
  canFullscreen: () => boolean;
  /** Request fullscreen, returning true only when the host entered it. */
  requestFullscreen: () => Promise<boolean>;
  /** Toggle between inline and fullscreen when the host supports both. */
  toggleFullscreen: () => Promise<McpAppDisplayMode>;
}

export interface AppCallToolResult {
  readonly isError?: boolean;
  readonly content?: ReadonlyArray<{
    readonly type: string;
    readonly text?: string;
  }>;
  readonly structuredContent?: unknown;
  readonly _meta?: Readonly<Record<string, unknown>>;
}

type RawServerToolCaller = {
  callServerTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<AppCallToolResult>;
};

/** Minimal structural surface accepted by `callAppTool` (`App`, `AppWorkspace`, or test double). */
export type AppToolCaller =
  | RawServerToolCaller
  | { readonly app: RawServerToolCaller };

export type AppToolOutcome<Output = Record<string, unknown>> =
  | {
      readonly status: "applied";
      readonly ok: true;
      readonly uncertain: false;
      readonly requestId?: string;
      readonly data: Output;
      readonly text: string | null;
      readonly raw: AppCallToolResult;
    }
  | {
      readonly status: "refused";
      readonly ok: false;
      readonly uncertain: false;
      readonly requestId?: string;
      readonly code: string | null;
      readonly message: string;
      readonly cause?: unknown;
      readonly raw?: AppCallToolResult;
    }
  | {
      readonly status: "uncertain";
      readonly ok: false;
      readonly uncertain: true;
      readonly requestId: string;
      readonly message: string;
      readonly cause?: unknown;
      readonly raw?: AppCallToolResult;
      /** Retry the exact same tool call, arguments, and `request_id`. */
      retry(): Promise<AppToolOutcome<Output>>;
    };

export interface CallAppToolOptions<Output = Record<string, unknown>> {
  /**
   * Idempotency behavior:
   * - `true` (default): mints `request_id = crypto.randomUUID()` once per intent and injects
   *   `[requestIdField]: requestId` into tool arguments, preserving it across `.retry()`.
   * - `false`: read-only call – injects no `request_id` (safe for `.strict()` read schemas) and
   *   classifies transport failures without `uncertain` write warnings.
   */
  readonly idempotent?: boolean;
  /** Reuse an existing `request_id` for a manual retry. */
  readonly requestId?: string;
  /** Argument key carrying the UUID. Defaults to `"request_id"`. */
  readonly requestIdField?: string;
  /** Per-attempt timeout in milliseconds before entering `uncertain`. Defaults to `15_000`. */
  readonly timeoutMs?: number;
  /** Narrow and validate `result.structuredContent` before reporting `"applied"`. */
  readonly guard?: (value: unknown) => value is Output;
  /**
   * Error codes in `<code_prefix>: <message>` that prove the server rejected BEFORE writing.
   * Defaults to `DEFINITIVE_REFUSAL_CODES`.
   */
  readonly definitiveRefusalCodes?: readonly string[];
}

export interface AppMutationSnapshot<Input, Output> {
  readonly status: "idle" | "busy" | "applied" | "refused" | "uncertain";
  readonly busy: boolean;
  readonly uncertain: boolean;
  readonly requestId: string | null;
  readonly input: Input | null;
  readonly data: Output | null;
  readonly message: string | null;
  readonly canRetry: boolean;
}

export interface CreateAppMutationOptions<Input, Output> extends Omit<
  CallAppToolOptions<Output>,
  "requestId"
> {
  readonly tool: string;
  readonly toArguments: (input: Input) => Record<string, unknown>;
  /** Optional mount check (e.g. `() => root.isConnected`); suppresses callbacks after unmount. */
  readonly isConnected?: () => boolean;
  readonly onStateChange?: (
    snapshot: AppMutationSnapshot<Input, Output>,
  ) => void;
}

export interface AppMutation<Input, Output = Record<string, unknown>> {
  getSnapshot(): AppMutationSnapshot<Input, Output>;
  /** Start a new user intent (ignored if `busy` is true). Mints a fresh `request_id`. */
  run(input: Input): Promise<AppToolOutcome<Output> | null>;
  /** Re-send the pending `uncertain` intent with its original `input` and `request_id`. */
  retry(): Promise<AppToolOutcome<Output> | null>;
  /** Explicitly clear `uncertain` / `refused` state (e.g. after a full queue reload). */
  reset(): void;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function installWorkspaceStyles(doc: Document) {
  if (doc.getElementById(WORKSPACE_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = WORKSPACE_STYLE_ID;
  style.textContent = WORKSPACE_CSS;
  doc.head.append(style);
}

function setPixels(element: HTMLElement, name: string, value: number) {
  element.style.setProperty(name, `${Math.max(0, value)}px`);
}

/**
 * Read and sanitize the server-injected `<script id="mcp-app-presentation" type="application/json">`
 * block. Returns `NEUTRAL_APP_PRESENTATION` when absent or uninjected during static HTML preview.
 */
export function readAppPresentation(
  doc: Pick<Document, "getElementById"> | undefined = typeof document !==
  "undefined"
    ? document
    : undefined,
): McpAppPresentation {
  if (!doc || typeof doc.getElementById !== "function") {
    return NEUTRAL_APP_PRESENTATION;
  }
  const element = doc.getElementById(MCP_APP_PRESENTATION_SCRIPT_ID);
  const rawText = element?.textContent?.trim();
  if (!rawText) return NEUTRAL_APP_PRESENTATION;
  try {
    const parsed = JSON.parse(rawText) as unknown;
    return sanitizeAppPresentationPayload(parsed, {
      allowLocalhostOrigins: true,
    });
  } catch {
    return NEUTRAL_APP_PRESENTATION;
  }
}

/**
 * Apply validated presentation brand/theme tokens as CSS custom properties on `documentElement`.
 */
export function applyAppPresentation(
  presentation: McpAppPresentation,
  options: {
    readonly document?: Pick<Document, "documentElement">;
    readonly scheme?: "light" | "dark";
  } = {},
): void {
  const brand = presentation.brand;
  if (!brand) return;
  const targetDoc =
    options.document ??
    (typeof document !== "undefined" ? document : undefined);
  const root = targetDoc?.documentElement;
  if (!root?.style || typeof root.style.setProperty !== "function") return;

  if (brand.fontFamily) {
    root.style.setProperty("--chumbo-font-family", brand.fontFamily);
  }
  if (brand.colors) {
    if (brand.colors.accent) {
      root.style.setProperty("--chumbo-brand-accent", brand.colors.accent);
    }
    if (brand.colors.accentSoft) {
      root.style.setProperty(
        "--chumbo-brand-accent-soft",
        brand.colors.accentSoft,
      );
    }
    if (brand.colors.ink) {
      root.style.setProperty("--chumbo-brand-ink", brand.colors.ink);
    }
    if (brand.colors.surface) {
      root.style.setProperty("--chumbo-brand-surface", brand.colors.surface);
    }
  }
  if (brand.theme) {
    const activeScheme = options.scheme ?? brand.theme.defaultScheme ?? "light";
    const palette =
      activeScheme === "dark"
        ? (brand.theme.dark ?? brand.theme.light)
        : (brand.theme.light ?? brand.theme.dark);
    if (palette) {
      root.style.setProperty("--chumbo-bg", palette.background);
      root.style.setProperty("--chumbo-surface", palette.surface);
      root.style.setProperty("--chumbo-border", palette.border);
      root.style.setProperty("--chumbo-text", palette.text);
      root.style.setProperty("--chumbo-text-secondary", palette.textSecondary);
    }
  }
}

/** Apply MCP host theme, CSS variables, font definitions, and safe-area insets to a document element. */
export function applyHostContextToDocument(
  documentElement: HTMLElement,
  context: McpAppHostContext,
): void {
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) {
    applyHostStyleVariables(context.styles.variables);
  }
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);

  const safeArea = context.safeAreaInsets ?? {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  };
  setPixels(documentElement, "--supa-mcp-safe-top", safeArea.top);
  setPixels(documentElement, "--supa-mcp-safe-right", safeArea.right);
  setPixels(documentElement, "--supa-mcp-safe-bottom", safeArea.bottom);
  setPixels(documentElement, "--supa-mcp-safe-left", safeArea.left);
  documentElement.dataset.supaMcpDisplayMode = context.displayMode ?? "inline";
  if (context.platform) {
    documentElement.dataset.supaMcpPlatform = context.platform;
  }
}

function resolveRawCaller(caller: AppToolCaller): RawServerToolCaller {
  return "app" in caller ? caller.app : caller;
}

function firstTextBlock(result: AppCallToolResult): string | null {
  const block = result.content?.find(
    (entry) => entry.type === "text" && typeof entry.text === "string",
  );
  return block?.text ?? null;
}

function extractErrorCode(text: string | null): string | null {
  if (!text) return null;
  const match = /^([a-z][a-z0-9_]*):\s*/u.exec(text.trim());
  return match?.[1] ?? null;
}

async function callWithTimeout(
  caller: RawServerToolCaller,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<AppCallToolResult> {
  if (!finite(timeoutMs)) {
    return await caller.callServerTool({ name, arguments: args });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      caller.callServerTool({ name, arguments: args }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("mcp_app_tool_timeout"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Invoke a server tool from a View with structured outcome classification and stable `request_id` retry.
 */
export async function callAppTool<Output = Record<string, unknown>>(
  caller: AppToolCaller,
  name: string,
  args: Readonly<Record<string, unknown>> = {},
  options: CallAppToolOptions<Output> = {},
): Promise<AppToolOutcome<Output>> {
  const rawCaller = resolveRawCaller(caller);
  const idempotent = options.idempotent ?? true;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const refusalCodes = new Set(
    options.definitiveRefusalCodes ?? DEFINITIVE_REFUSAL_CODES,
  );

  if (!idempotent) {
    try {
      const result = await callWithTimeout(
        rawCaller,
        name,
        { ...args },
        timeoutMs,
      );
      const text = firstTextBlock(result);
      if (result.isError) {
        return {
          status: "refused",
          ok: false,
          uncertain: false,
          code: extractErrorCode(text),
          message: text ?? "The request could not be completed.",
          raw: result,
        };
      }
      if (options.guard && !options.guard(result.structuredContent)) {
        return {
          status: "refused",
          ok: false,
          uncertain: false,
          code: "unreadable_response",
          message: "The server returned an unreadable response. Try again.",
          raw: result,
        };
      }
      return {
        status: "applied",
        ok: true,
        uncertain: false,
        data: (result.structuredContent ?? {}) as Output,
        text,
        raw: result,
      };
    } catch (error) {
      return {
        status: "refused",
        ok: false,
        uncertain: false,
        code: "transport_error",
        message: "The request did not reach the server. Try again.",
        cause: error,
      };
    }
  }

  const requestIdField = options.requestIdField ?? "request_id";
  const requestId = options.requestId ?? crypto.randomUUID();
  const payload = { ...args, [requestIdField]: requestId };
  const retrySameIntent = () =>
    callAppTool<Output>(caller, name, args, { ...options, requestId });

  let result: AppCallToolResult;
  try {
    result = await callWithTimeout(rawCaller, name, payload, timeoutMs);
  } catch (error) {
    return {
      status: "uncertain",
      ok: false,
      uncertain: true,
      requestId,
      message: "The change wasn't confirmed. Retry to check and finish it.",
      cause: error,
      retry: retrySameIntent,
    };
  }

  const text = firstTextBlock(result);
  if (result.isError) {
    const code = extractErrorCode(text);
    const explicitlyUncommitted =
      result._meta?.["dev.chumbo/committed"] === false ||
      (code !== null && refusalCodes.has(code));
    if (explicitlyUncommitted) {
      return {
        status: "refused",
        ok: false,
        uncertain: false,
        requestId,
        code,
        message: text ?? "The request could not be completed.",
        raw: result,
      };
    }
    return {
      status: "uncertain",
      ok: false,
      uncertain: true,
      requestId,
      message:
        text ?? "The change wasn't confirmed. Retry to check and finish it.",
      raw: result,
      retry: retrySameIntent,
    };
  }

  if (options.guard && !options.guard(result.structuredContent)) {
    return {
      status: "uncertain",
      ok: false,
      uncertain: true,
      requestId,
      message: "The change wasn't confirmed. Retry to check and finish it.",
      raw: result,
      retry: retrySameIntent,
    };
  }

  return {
    status: "applied",
    ok: true,
    uncertain: false,
    requestId,
    data: (result.structuredContent ?? {}) as Output,
    text,
    raw: result,
  };
}

/** Convenience wrapper for read-only View calls (`idempotent: false`). */
export function readAppTool<Output = Record<string, unknown>>(
  caller: AppToolCaller,
  name: string,
  args: Readonly<Record<string, unknown>> = {},
  options: Omit<
    CallAppToolOptions<Output>,
    "idempotent" | "requestId" | "requestIdField"
  > = {},
): Promise<AppToolOutcome<Output>> {
  return callAppTool<Output>(caller, name, args, {
    ...options,
    idempotent: false,
  });
}

/** Stateful UI mutation controller managing busy, uncertain, and stable request_id retry states. */
export function createAppMutation<Input, Output = Record<string, unknown>>(
  caller: AppToolCaller,
  options: CreateAppMutationOptions<Input, Output>,
): AppMutation<Input, Output> {
  let snapshot: AppMutationSnapshot<Input, Output> = Object.freeze({
    status: "idle",
    busy: false,
    uncertain: false,
    requestId: null,
    input: null,
    data: null,
    message: null,
    canRetry: false,
  });
  let pending: { readonly input: Input; readonly requestId: string } | null =
    null;
  let epoch = 0;

  function emit(next: AppMutationSnapshot<Input, Output>) {
    snapshot = Object.freeze(next);
    if (options.isConnected && !options.isConnected()) return;
    options.onStateChange?.(snapshot);
  }

  async function execute(
    input: Input,
    requestId: string,
  ): Promise<AppToolOutcome<Output> | null> {
    if (snapshot.busy) return null;
    const runEpoch = ++epoch;
    pending = { input, requestId };
    emit({
      status: "busy",
      busy: true,
      uncertain: snapshot.uncertain,
      requestId,
      input,
      data: snapshot.data,
      message: "Saving…",
      canRetry: false,
    });

    const outcome = await callAppTool<Output>(
      caller,
      options.tool,
      options.toArguments(input),
      {
        idempotent: options.idempotent ?? true,
        requestId,
        requestIdField: options.requestIdField,
        timeoutMs: options.timeoutMs,
        guard: options.guard,
        definitiveRefusalCodes: options.definitiveRefusalCodes,
      },
    );

    if (runEpoch !== epoch) return null;
    if (options.isConnected && !options.isConnected()) return null;

    if (outcome.status === "applied") {
      pending = null;
      emit({
        status: "applied",
        busy: false,
        uncertain: false,
        requestId: null,
        input,
        data: outcome.data,
        message: outcome.text,
        canRetry: false,
      });
      return outcome;
    }

    if (outcome.status === "refused") {
      pending = null;
      emit({
        status: "refused",
        busy: false,
        uncertain: false,
        requestId: null,
        input,
        data: snapshot.data,
        message: outcome.message,
        canRetry: false,
      });
      return outcome;
    }

    emit({
      status: "uncertain",
      busy: false,
      uncertain: true,
      requestId: outcome.requestId,
      input,
      data: snapshot.data,
      message: outcome.message,
      canRetry: true,
    });
    return outcome;
  }

  return {
    getSnapshot: () => snapshot,
    run(input: Input) {
      if (snapshot.busy) return Promise.resolve(null);
      return execute(input, crypto.randomUUID());
    },
    retry() {
      if (snapshot.busy || snapshot.status !== "uncertain" || !pending) {
        return Promise.resolve(null);
      }
      return execute(pending.input, pending.requestId);
    },
    reset() {
      epoch += 1;
      pending = null;
      emit({
        status: "idle",
        busy: false,
        uncertain: false,
        requestId: null,
        input: null,
        data: null,
        message: null,
        canRetry: false,
      });
    },
  };
}

/**
 * Create a host-aware MCP App workspace with stable inline dimensions.
 *
 * The helper deliberately owns only MCP host mechanics: theme/font tokens,
 * safe areas, one bounded inline size, internal scrolling, optional
 * fullscreen negotiation, and server-injected brand presentation tokens.
 */
export function createAppWorkspace(
  appInfo: SupaMcpAppInfo,
  options: CreateAppWorkspaceOptions,
): AppWorkspace {
  const root = options.root;
  const doc = root.ownerDocument;
  const documentElement = doc.documentElement;
  const shouldApplyPresentation = options.applyPresentation ?? true;
  const presentation = readAppPresentation(doc);
  if (shouldApplyPresentation) {
    applyAppPresentation(presentation, { document: doc });
  }

  const preferredHeight = finite(options.inlineHeight)
    ? options.inlineHeight
    : DEFAULT_INLINE_HEIGHT;
  const minimumHeight = finite(options.minInlineHeight)
    ? options.minInlineHeight
    : DEFAULT_MIN_INLINE_HEIGHT;
  const maximumHeight = finite(options.maxInlineHeight)
    ? options.maxInlineHeight
    : DEFAULT_MAX_INLINE_HEIGHT;
  const boundedPreferredHeight = clamp(
    preferredHeight,
    Math.min(minimumHeight, maximumHeight),
    Math.max(minimumHeight, maximumHeight),
  );
  const capabilities: McpAppCapabilities = {
    availableDisplayModes: ["inline", "fullscreen"],
    ...options.capabilities,
  };
  const app = new App(appInfo, capabilities, { autoResize: false });
  let connected = false;
  let hostContext: McpAppHostContext | undefined;

  installWorkspaceStyles(doc);
  documentElement.dataset.supaMcpLayout = "workspace";
  root.dataset.supaMcpWorkspace = "";
  root.dataset.supaMcpScrollFallback = String(
    root.querySelector("[data-supa-mcp-scroll]") === null,
  );

  function desiredHeight(context: McpAppHostContext): number | undefined {
    if (context.displayMode && context.displayMode !== "inline")
      return undefined;
    const dimensions = context.containerDimensions;
    if (dimensions && "height" in dimensions && finite(dimensions.height)) {
      return dimensions.height;
    }
    if (
      dimensions &&
      "maxHeight" in dimensions &&
      finite(dimensions.maxHeight)
    ) {
      return Math.min(boundedPreferredHeight, dimensions.maxHeight);
    }
    return boundedPreferredHeight;
  }

  function applyHostContext(update: McpAppHostContext) {
    hostContext = { ...hostContext, ...update };
    const context = hostContext;
    applyHostContextToDocument(documentElement, context);
    if (shouldApplyPresentation) {
      applyAppPresentation(presentation, {
        document: doc,
        scheme: context.theme,
      });
    }

    const height = desiredHeight(context);
    documentElement.style.setProperty(
      "--supa-mcp-app-height",
      height ? `${height}px` : "100dvh",
    );
    if (connected && height) {
      void app.sendSizeChanged({ height }).catch(() => undefined);
    }
  }

  app.addEventListener("hostcontextchanged", applyHostContext);

  async function connect(...args: Parameters<App["connect"]>): Promise<void> {
    await app.connect(...args);
    connected = true;
    applyHostContext((app.getHostContext() ?? {}) as McpAppHostContext);
  }

  function canFullscreen(): boolean {
    return hostContext?.availableDisplayModes?.includes("fullscreen") ?? false;
  }

  async function setDisplayMode(mode: "inline" | "fullscreen") {
    if (!hostContext?.availableDisplayModes?.includes(mode)) {
      return hostContext?.displayMode ?? "inline";
    }
    const result = await app.requestDisplayMode({ mode });
    applyHostContext({ displayMode: result.mode });
    return result.mode;
  }

  return {
    app,
    presentation,
    hubUrl: (path, params) => buildHubUrl(presentation, path, params),
    connect,
    getHostContext: () => hostContext,
    canFullscreen,
    requestFullscreen: async () =>
      (await setDisplayMode("fullscreen")) === "fullscreen",
    toggleFullscreen: async () =>
      await setDisplayMode(
        hostContext?.displayMode === "fullscreen" ? "inline" : "fullscreen",
      ),
  };
}
