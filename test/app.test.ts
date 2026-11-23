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

    emit(name: string, value: unknown) {
      for (const listener of this.listeners.get(name) ?? []) {
        listener(value);
      }
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

import {
  applyAppPresentation,
  callAppTool,
  createAppMutation,
  createAppWorkspace,
  MCP_APP_PRESENTATION_SCRIPT_ID,
  NEUTRAL_APP_PRESENTATION,
  readAppPresentation,
  readAppTool,
  type AppCallToolResult,
  type AppMutationSnapshot,
} from "../src/app.js";

class FakeStyle {
  values = new Map<string, string>();
  setProperty(name: string, value: string) {
    this.values.set(name, value);
  }
}

function fixture(hasScrollRegion = true, presentationJson?: string) {
  const documentElement = {
    dataset: {} as Record<string, string>,
    style: new FakeStyle(),
  };
  const head = { append: vi.fn() };
  const document = {
    documentElement,
    head,
    getElementById: vi.fn((id: string) => {
      if (
        id === MCP_APP_PRESENTATION_SCRIPT_ID &&
        presentationJson !== undefined
      ) {
        return { textContent: presentationJson };
      }
      return null;
    }),
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
    document: document as unknown as Document,
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

  it("reads injected tenant presentation, syncs light/dark brand palettes with host theme, and builds safe hub URLs", async () => {
    const { root, document, documentElement } = fixture(
      true,
      JSON.stringify({
        productName: "Acme Hub",
        hubUrl: "https://app.acme.example",
        brand: {
          logoUrl: "https://cdn.acme.example/logo.svg",
          fontFamily: "Geist, system-ui, sans-serif",
          colors: { accent: "#1d6f42", accentSoft: "#e4f3ea" },
          theme: {
            light: {
              background: "#ffffff",
              surface: "#f6f8f7",
              border: "#d5ddd8",
              text: "#141a16",
              textSecondary: "#56635b",
            },
            dark: {
              background: "#0f1311",
              surface: "#181e1a",
              border: "#2b352f",
              text: "#eef3f0",
              textSecondary: "#97a69d",
            },
            defaultScheme: "light",
          },
        },
      }),
    );

    const workspace = createAppWorkspace(
      { name: "Review Queue", version: "0.1.0" },
      { root },
    );
    expect(workspace.presentation.productName).toBe("Acme Hub");
    expect(workspace.hubUrl("/records", { id: "rec-42" })).toBe(
      "https://app.acme.example/records?id=rec-42",
    );
    expect(documentElement.style.values.get("--chumbo-bg")).toBe("#ffffff");
    expect(documentElement.style.values.get("--chumbo-brand-accent")).toBe(
      "#1d6f42",
    );

    const app = workspace.app as unknown as {
      hostContext: Record<string, unknown>;
      emit(name: string, value: unknown): void;
    };
    app.hostContext = { theme: "dark" };
    await workspace.connect();
    expect(documentElement.style.values.get("--chumbo-bg")).toBe("#0f1311");

    app.emit("hostcontextchanged", { theme: "light" });
    expect(documentElement.style.values.get("--chumbo-bg")).toBe("#ffffff");

    // Uninjected placeholder or malformed DOM script falls back cleanly and drops unsafe CSS/URLs:
    const uninjected = fixture(true, "__MCP_" + "APP_PRESENTATION__");
    expect(readAppPresentation(uninjected.document)).toEqual(
      NEUTRAL_APP_PRESENTATION,
    );

    const untrusted = fixture(
      true,
      JSON.stringify({
        productName: "Safe Name",
        hubUrl: "javascript:alert(1)",
        brand: {
          logoUrl: "data:text/html,<script>alert(1)</script>",
          fontFamily: "Inter; background:url(https://evil.test)",
          colors: { accent: "expression(alert(1))" },
        },
      }),
    );
    const sanitized = readAppPresentation(untrusted.document);
    expect(sanitized).toEqual({
      schemaVersion: 1,
      productName: "Safe Name",
      hubUrl: null,
    });
    applyAppPresentation(sanitized, { document: untrusted.document });
    expect(untrusted.documentElement.style.values.size).toBe(0);
  });
});

describe("callAppTool, readAppTool, and createAppMutation", () => {
  it("preserves a stable request_id across uncertain retries and distinguishes definitive refusals", async () => {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> =
      [];
    let attempt = 0;
    const caller = {
      async callServerTool(params: {
        name: string;
        arguments?: Record<string, unknown>;
      }): Promise<AppCallToolResult> {
        calls.push(params);
        attempt += 1;
        if (attempt === 1) {
          throw new Error("socket disconnected");
        }
        if (attempt === 2) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "write_failed: The change could not be confirmed.",
              },
            ],
          };
        }
        return {
          content: [{ type: "text", text: "Added to Launch." }],
          structuredContent: { outcome: "applied", collectionId: "col-1" },
        };
      },
    };

    const first = await callAppTool<{ outcome: string; collectionId: string }>(
      caller,
      "file_collection_for_app",
      { file: "file:1", collection_id: "col-1", present: true },
      {
        guard: (value): value is { outcome: string; collectionId: string } =>
          typeof value === "object" &&
          value !== null &&
          (value as { outcome?: unknown }).outcome === "applied",
      },
    );

    expect(first.status).toBe("uncertain");
    if (first.status !== "uncertain") throw new Error("expected uncertain");
    const initialRequestId = first.requestId;
    expect(initialRequestId).toMatch(/^[0-9a-f-]{36}$/iu);

    const second = await first.retry();
    expect(second.status).toBe("uncertain");
    if (second.status !== "uncertain") throw new Error("expected uncertain");
    expect(second.requestId).toBe(initialRequestId);

    const third = await second.retry();
    expect(third.status).toBe("applied");
    if (third.status !== "applied") throw new Error("expected applied");
    expect(third.data).toEqual({ outcome: "applied", collectionId: "col-1" });
    expect(calls).toHaveLength(3);
    expect(calls[0]?.arguments?.request_id).toBe(initialRequestId);
    expect(calls[1]?.arguments?.request_id).toBe(initialRequestId);
    expect(calls[2]?.arguments?.request_id).toBe(initialRequestId);

    // Definitive non-write refusal returns `status: "refused"`, `uncertain: false`:
    const refusedCaller = {
      async callServerTool(): Promise<AppCallToolResult> {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "state_changed: Item was already decided.",
            },
          ],
        };
      },
    };
    const refused = await callAppTool(refusedCaller, "decide_review_flag", {
      id: "flag-1",
    });
    expect(refused).toMatchObject({
      status: "refused",
      ok: false,
      uncertain: false,
      code: "state_changed",
    });

    // `readAppTool` (`idempotent: false`) sends zero `request_id` for `.strict()` read tools:
    const readCalls: Array<Record<string, unknown> | undefined> = [];
    const readRes = await readAppTool(
      {
        async callServerTool(params) {
          readCalls.push(params.arguments);
          return { structuredContent: { items: [] } };
        },
      },
      "refresh_review_queue",
      { status: "pending" },
    );
    expect(readRes.status).toBe("applied");
    expect(readCalls).toEqual([{ status: "pending" }]);
  });

  it("times out hung server calls into uncertain state and guards createAppMutation against double-submit and unmount", async () => {
    const hungCaller = {
      callServerTool: () => new Promise<AppCallToolResult>(() => {}),
    };
    const timedOut = await callAppTool(
      hungCaller,
      "decide_item",
      { id: "1" },
      { timeoutMs: 20 },
    );
    expect(timedOut.status).toBe("uncertain");

    let connected = true;
    let shouldFail = true;
    let resolveInFlight: ((value: AppCallToolResult) => void) | undefined;
    const seenRequestIds: string[] = [];
    const snapshots: Array<
      AppMutationSnapshot<{ id: string; decision: string }, { ok: boolean }>
    > = [];

    const mutation = createAppMutation<
      { id: string; decision: string },
      { ok: boolean }
    >(
      {
        callServerTool(params) {
          seenRequestIds.push(String(params.arguments?.request_id));
          if (shouldFail) {
            return new Promise<AppCallToolResult>((resolve) => {
              resolveInFlight = resolve;
            });
          }
          return Promise.resolve({
            content: [{ type: "text", text: "Resolved." }],
            structuredContent: { ok: true },
          });
        },
      },
      {
        tool: "decide_review_flag",
        toArguments: (input) => ({ id: input.id, decision: input.decision }),
        guard: (val): val is { ok: boolean } =>
          typeof val === "object" &&
          val !== null &&
          (val as { ok?: unknown }).ok === true,
        isConnected: () => connected,
        onStateChange: (snap) => snapshots.push(snap),
      },
    );

    const firstPromise = mutation.run({ id: "item-1", decision: "resolved" });
    expect(mutation.getSnapshot().busy).toBe(true);
    // Double-click while busy is ignored without minting a second UUID:
    expect(
      await mutation.run({ id: "item-1", decision: "dismissed" }),
    ).toBeNull();
    expect(seenRequestIds).toHaveLength(1);

    resolveInFlight!({
      isError: true,
      content: [{ type: "text", text: "review_failed: Connection dropped." }],
    });
    const firstOutcome = await firstPromise;
    expect(firstOutcome?.status).toBe("uncertain");
    expect(mutation.getSnapshot().canRetry).toBe(true);

    // Retry reuses exact same request_id and input:
    shouldFail = false;
    const retried = await mutation.retry();
    expect(retried?.status).toBe("applied");
    expect(seenRequestIds).toHaveLength(2);
    expect(seenRequestIds[0]).toBe(seenRequestIds[1]);
    expect(mutation.getSnapshot().status).toBe("applied");
    expect(mutation.getSnapshot().uncertain).toBe(false);

    // Unmounted root suppresses further callback emissions:
    const countBeforeUnmount = snapshots.length;
    connected = false;
    await mutation.run({ id: "item-2", decision: "resolved" });
    expect(snapshots).toHaveLength(countBeforeUnmount);
  });
});
