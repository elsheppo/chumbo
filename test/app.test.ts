import { beforeEach, describe, expect, it, vi } from "vitest";

const styleCalls = vi.hoisted(() => ({
  theme: vi.fn(),
  fonts: vi.fn(),
  variables: vi.fn(),
}));

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  applyDocumentTheme: styleCalls.theme,
  applyHostFonts: styleCalls.fonts,
  applyHostStyleVariables: styleCalls.variables,
  App: class FakeApp {
    options: unknown;
    capabilities: unknown;
    hostContext: Record<string, unknown> = {};
    sizeChanges: Array<{ height?: number }> = [];
    listeners = new Map<string, Array<(value: unknown) => void>>();

    constructor(_info: unknown, capabilities: unknown, options: unknown) {
      this.capabilities = capabilities;
      this.options = options;
    }

    addEventListener(name: string, listener: (value: unknown) => void) {
      const listeners = this.listeners.get(name) ?? [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    }

    async connect() {}
    getHostContext() {
      return this.hostContext;
    }
    async sendSizeChanged(value: { height?: number }) {
      this.sizeChanges.push(value);
    }
    async requestDisplayMode({ mode }: { mode: string }) {
      this.hostContext = { ...this.hostContext, displayMode: mode };
      return { mode };
    }
  },
}));

import { createAppWorkspace } from "../src/app.js";

class FakeStyle {
  values = new Map<string, string>();
  setProperty(name: string, value: string) {
    this.values.set(name, value);
  }
}

function fixture(hasScrollRegion = true) {
  const documentElement = {
    dataset: {} as Record<string, string>,
    style: new FakeStyle(),
  };
  const head = { append: vi.fn() };
  const document = {
    documentElement,
    head,
    getElementById: vi.fn(() => null),
    createElement: vi.fn(() => ({
      id: "",
      textContent: "",
    })),
  };
  const root = {
    ownerDocument: document,
    dataset: {} as Record<string, string>,
    querySelector: vi.fn(() => (hasScrollRegion ? {} : null)),
  };
  return {
    documentElement,
    head,
    root: root as unknown as HTMLElement,
  };
}

describe("createAppWorkspace", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses one bounded host-aware viewport instead of content auto-resize", async () => {
    const { root, documentElement, head } = fixture();
    const workspace = createAppWorkspace(
      { name: "Gallery", version: "0.1.0" },
      { root, inlineHeight: 620 },
    );
    const app = workspace.app as unknown as {
      options: { autoResize: boolean };
      hostContext: Record<string, unknown>;
      sizeChanges: Array<{ height?: number }>;
    };
    app.hostContext = {
      theme: "dark",
      styles: { variables: { "--color-text-primary": "#fff" } },
      displayMode: "inline",
      availableDisplayModes: ["inline", "fullscreen"],
      containerDimensions: { maxHeight: 540, width: 390 },
      safeAreaInsets: { top: 12, right: 0, bottom: 8, left: 0 },
    };

    await workspace.connect();

    expect(app.options.autoResize).toBe(false);
    expect(documentElement.dataset.supaMcpLayout).toBe("workspace");
    expect(documentElement.style.values.get("--supa-mcp-app-height")).toBe(
      "540px",
    );
    expect(documentElement.style.values.get("--supa-mcp-safe-top")).toBe(
      "12px",
    );
    expect(app.sizeChanges).toEqual([{ height: 540 }]);
    expect(head.append).toHaveBeenCalledOnce();
    expect(styleCalls.theme).toHaveBeenCalledWith("dark");
  });

  it("falls back to root scrolling and negotiates fullscreen explicitly", async () => {
    const { root, documentElement } = fixture(false);
    const workspace = createAppWorkspace(
      { name: "Gallery", version: "0.1.0" },
      { root },
    );
    const app = workspace.app as unknown as {
      hostContext: Record<string, unknown>;
    };
    app.hostContext = {
      displayMode: "inline",
      availableDisplayModes: ["inline", "fullscreen"],
    };

    await workspace.connect();
    expect((root as HTMLElement).dataset.supaMcpScrollFallback).toBe("true");
    expect(await workspace.toggleFullscreen()).toBe("fullscreen");
    expect(documentElement.style.values.get("--supa-mcp-app-height")).toBe(
      "100dvh",
    );
  });
});
