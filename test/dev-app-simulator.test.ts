import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMcpAppCspHeader,
  injectCspViolationReporter,
  renderAppHostBridgeScript,
  startDevAppSimulator,
  type DevAppSimulatorHandle,
} from "../src/dev-app-simulator.js";

const handles: DevAppSimulatorHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    await handles.pop()!.close();
  }
});

describe("dev-app-simulator CSP synthesis, inline host bridge, and isolated sandbox server", () => {
  it("synthesizes SEP-1865 HTTP CSP directives with 'none' defaults and resourceDomains on script-src", () => {
    expect(buildMcpAppCspHeader({})).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
    );

    const header = buildMcpAppCspHeader({
      connectDomains: ["https://files.example.com"],
      resourceDomains: [
        "https://cdn.example.com",
        "https://*.assets.example.com",
      ],
      frameDomains: ["https://embed.example.com"],
      baseUriDomains: ["https://app.example.com"],
    });
    expect(header).toContain(
      "script-src 'unsafe-inline' https://cdn.example.com https://*.assets.example.com",
    );
    expect(header).toContain(
      "img-src data: blob: https://cdn.example.com https://*.assets.example.com",
    );
    expect(header).toContain("connect-src https://files.example.com");
    expect(header).toContain("frame-src https://embed.example.com");
    expect(header).toContain("base-uri https://app.example.com");
    expect(header).not.toContain("'unsafe-eval'");
  });

  it("injects the CSP violation reporter and renders a zero-v1-SDK inline host bridge gated on opaque origin", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../src/dev-app-simulator.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["']@modelcontextprotocol\/sdk/u);
    expect(source).not.toMatch(
      /from\s+["']@modelcontextprotocol\/ext-apps\/app-bridge/u,
    );

    const wrapped = injectCspViolationReporter(
      "<!doctype html><html><head><title>App</title></head><body></body></html>",
    );
    expect(wrapped).toContain("securitypolicyviolation");
    expect(wrapped.indexOf("securitypolicyviolation")).toBeLessThan(
      wrapped.indexOf("<title>App</title>"),
    );

    const bridge = renderAppHostBridgeScript({
      workbenchToken: "wb-token-123",
      sandboxOrigin: "http://127.0.0.1:54331",
    });
    expect(bridge).toContain(
      'event.source!==iframe.contentWindow||event.origin!=="null"',
    );
    expect(bridge).toContain("ui/initialize");
    expect(bridge).toContain("ui/notifications/initialized");
    expect(bridge).toContain("x-chumbo-workbench-token");
    expect(bridge).toContain("dropNextMutationReply");
  });

  it("serves staged views on an isolated 127.0.0.1 port with strict CSP and Host/Origin checks", async () => {
    const sim = await startDevAppSimulator();
    handles.push(sim);

    expect(sim.sandboxOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    const staged = sim.stageView({
      uri: "ui://mcp/review-queue.html",
      html: "<!doctype html><html><head></head><body>Hello View</body></html>",
      csp: { resourceDomains: ["https://cdn.example.com"] },
    });

    const okRes = await fetch(staged.url);
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(okRes.headers.get("content-security-policy")).toBe(staged.cspHeader);
    expect(okRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(okRes.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await okRes.text();
    expect(html).toContain("securitypolicyviolation");
    expect(html).toContain("Hello View");

    // Non-GET method returns 405:
    const postRes = await fetch(staged.url, { method: "POST" });
    expect(postRes.status).toBe(405);

    // Unknown view returns 404:
    const missingRes = await fetch(
      `${sim.sandboxOrigin}/view/00000000-0000-0000-0000-000000000000`,
    );
    expect(missingRes.status).toBe(404);

    // Cross-origin browser Origin is rejected with 403:
    const evilOriginRes = await fetch(staged.url, {
      headers: { origin: "https://evil.example.com" },
    });
    expect(evilOriginRes.status).toBe(403);

    // Workbench slot renders `<iframe ... sandbox="allow-scripts">` without `allow-same-origin`:
    const slotHtml = sim.renderWorkbenchSlotHtml({
      workbenchToken: "secret-token",
      initialAppName: "review-queue",
    });
    expect(slotHtml).toContain('sandbox="allow-scripts"');
    expect(slotHtml).not.toContain("allow-same-origin");
    expect(slotHtml).toContain(sim.sandboxOrigin);
  });
});
