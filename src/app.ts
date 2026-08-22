import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";

const DEFAULT_INLINE_HEIGHT = 560;
const DEFAULT_MIN_INLINE_HEIGHT = 360;
const DEFAULT_MAX_INLINE_HEIGHT = 720;
const WORKSPACE_STYLE_ID = "__supa-mcp-app-workspace";

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
}

export interface AppWorkspace {
  /** The official MCP Apps client. Register event handlers before connect(). */
  app: App;
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

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function installWorkspaceStyles(document: Document) {
  if (document.getElementById(WORKSPACE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = WORKSPACE_STYLE_ID;
  style.textContent = WORKSPACE_CSS;
  document.head.append(style);
}

function setPixels(element: HTMLElement, name: string, value: number) {
  element.style.setProperty(name, `${Math.max(0, value)}px`);
}

/**
 * Create a host-aware MCP App workspace with stable inline dimensions.
 *
 * The helper deliberately owns only MCP host mechanics: theme/font tokens,
 * safe areas, one bounded inline size, internal scrolling, and optional
 * fullscreen negotiation. The builder still owns every visual and product
 * decision inside the workspace.
 */
export function createAppWorkspace(
  appInfo: SupaMcpAppInfo,
  options: CreateAppWorkspaceOptions,
): AppWorkspace {
  const root = options.root;
  const document = root.ownerDocument;
  const documentElement = document.documentElement;
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

  installWorkspaceStyles(document);
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
    if (context.theme) applyDocumentTheme(context.theme);
    if (context.styles?.variables)
      applyHostStyleVariables(context.styles.variables);
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
    documentElement.dataset.supaMcpDisplayMode =
      context.displayMode ?? "inline";
    if (context.platform) {
      documentElement.dataset.supaMcpPlatform = context.platform;
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
