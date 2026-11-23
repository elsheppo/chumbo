import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  describeAgentConnections,
  renderConnectMarkdown,
  type AgentClientConnection,
  type AgentClientId,
} from "../src/connect.js";

function clientById(
  clients: readonly AgentClientConnection[],
  id: AgentClientId,
): AgentClientConnection {
  const found = clients.find((entry) => entry.id === id);
  if (!found) throw new Error(`Missing client '${id}'`);
  return found;
}

describe("describeAgentConnections and renderConnectMarkdown", () => {
  it("stays 100% Web-standard with zero Node, React, or Zod imports", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../src/connect.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["']node:/u);
    expect(source).not.toMatch(/from\s+["']react/u);
    expect(source).not.toMatch(/from\s+["']zod/u);
  });

  it("renders truthful flows across oauth, public, api-key, bearer, and loopback endpoints", () => {
    // 1. OAuth over HTTPS + branded CLI:
    const oauthPlan = describeAgentConnections({
      productName: "Acme Hub",
      endpoint: "https://mcp.acme.example.com/mcp",
      authMode: "oauth",
      signInNote: "Sign in with your work email.",
      disconnectLocation: "Settings -> Integrations",
      samplePrompts: ["Summarize pending review items"],
      cli: {
        packageName: "@acme/cli",
        binaryName: "acme",
      },
    });
    expect(oauthPlan.valid).toBe(true);
    expect(oauthPlan.serverSlug).toBe("acme-hub");
    expect(oauthPlan.clients.map((c) => [c.id, c.availability])).toEqual([
      ["claude", "ready"],
      ["chatgpt", "ready"],
      ["claude-code", "ready"],
      ["cursor", "ready"],
      ["cli", "ready"],
    ]);
    expect(clientById(oauthPlan.clients, "claude-code").snippets[0]?.code).toBe(
      "claude mcp add --transport http acme-hub https://mcp.acme.example.com/mcp",
    );
    expect(clientById(oauthPlan.clients, "cli").snippets[0]?.code).toContain(
      "acme login",
    );

    // 2. API-key over HTTPS: Claude & ChatGPT report `unsupported_auth_mode`; Cursor uses `${env:...}`:
    const apiKeyPlan = describeAgentConnections({
      productName: "Acme Ops",
      endpoint: "https://api.acme.example/mcp",
      authMode: "api-key",
      tokenEnvVar: "ACME_API_KEY",
      cli: {
        packageName: "acme-cli",
        binaryName: "acme",
      },
    });
    expect(apiKeyPlan.valid).toBe(true);
    expect(clientById(apiKeyPlan.clients, "claude").availability).toBe(
      "unsupported_auth_mode",
    );
    expect(clientById(apiKeyPlan.clients, "chatgpt").availability).toBe(
      "unsupported_auth_mode",
    );
    expect(
      clientById(apiKeyPlan.clients, "claude-code").snippets[0]?.code,
    ).toBe(
      'claude mcp add --transport http acme-ops https://api.acme.example/mcp --header "Authorization: Bearer ${ACME_API_KEY}"',
    );

    const cursorClient = clientById(apiKeyPlan.clients, "cursor");
    expect(cursorClient.snippets[0]?.code).toContain(
      '"Authorization": "Bearer ${env:ACME_API_KEY}"',
    );
    expect(cursorClient.deeplink?.href).toMatch(
      /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=acme-ops&config=/u,
    );
    const configParam = new URL(cursorClient.deeplink!.href).searchParams.get(
      "config",
    )!;
    expect(JSON.parse(atob(configParam))).toEqual({
      url: "https://api.acme.example/mcp",
      headers: {
        Authorization: "Bearer ${env:ACME_API_KEY}",
      },
    });

    // 3. Loopback HTTP: Claude & ChatGPT report `requires_https_endpoint`; local clients stay `ready`:
    const localPlan = describeAgentConnections({
      productName: "Local Dev",
      endpoint: "http://127.0.0.1:54321/functions/v1/mcp",
      authMode: "oauth",
    });
    expect(localPlan.valid).toBe(true);
    expect(localPlan.isLoopback).toBe(true);
    expect(clientById(localPlan.clients, "claude").availability).toBe(
      "requires_https_endpoint",
    );
    expect(clientById(localPlan.clients, "chatgpt").availability).toBe(
      "requires_https_endpoint",
    );
    expect(clientById(localPlan.clients, "claude-code").availability).toBe(
      "ready",
    );
    expect(clientById(localPlan.clients, "cursor").availability).toBe("ready");
  });

  it("canonicalizes IDN hostnames and query strings safely for btoa and shell commands", () => {
    const idnPlan = describeAgentConnections({
      productName: "Bücher Archive",
      endpoint: "https://bücher.example/mcp?tenant=nord&v=2",
      authMode: "public",
    });
    expect(idnPlan.valid).toBe(true);
    expect(idnPlan.endpoint).toBe(
      "https://xn--bcher-kva.example/mcp?tenant=nord&v=2",
    );
    // Query-string `&` is single-quoted for POSIX shells so `&` never backgrounds a subcommand:
    expect(clientById(idnPlan.clients, "claude-code").snippets[0]?.code).toBe(
      "claude mcp add --transport http b-cher-archive 'https://xn--bcher-kva.example/mcp?tenant=nord&v=2'",
    );
    const cursorConfig = new URL(
      clientById(idnPlan.clients, "cursor").deeplink!.href,
    ).searchParams.get("config")!;
    expect(JSON.parse(atob(cursorConfig))).toEqual({
      url: "https://xn--bcher-kva.example/mcp?tenant=nord&v=2",
    });
  });

  it("rejects non-HTTPS remote URLs, javascript: schemes, embedded credentials, and live secrets in tokenEnvVar", () => {
    for (const invalid of [
      { productName: "Acme", endpoint: "javascript:alert(1)" },
      { productName: "Acme", endpoint: "http://remote.example.com/mcp" },
      { productName: "Acme", endpoint: "https://user:secret@example.com/mcp" },
      {
        productName: "Acme",
        endpoint: "https://example.com/mcp",
        authMode: "api-key" as const,
        tokenEnvVar: "sk_live_secret_value_123",
      },
      {
        productName: "Acme",
        endpoint: "https://example.com/mcp",
        headerName: 'Authorization" $(pwn)',
      },
      {
        productName: "Acme",
        endpoint: "https://example.com/mcp",
        cli: { packageName: "acme; rm -rf /", binaryName: "acme" },
      },
    ]) {
      const plan = describeAgentConnections(invalid);
      expect(plan.valid).toBe(false);
      expect(plan.clients).toEqual([]);
    }
  });

  it("renders end-user setup Markdown without em dashes", () => {
    const markdown = renderConnectMarkdown({
      productName: "Acme Knowledge",
      endpoint: "https://knowledge.acme.example/mcp",
      authMode: "api-key",
      tokenEnvVar: "ACME_TOKEN",
      supportContact: "help@acme.example",
      samplePrompts: ["Find the Q3 launch brief"],
    });

    expect(markdown).toContain("# Connect your AI assistant to Acme Knowledge");
    expect(markdown).toContain("## Claude Code");
    expect(markdown).toContain("## Cursor");
    expect(markdown).toContain("## Client compatibility notes");
    expect(markdown).toContain("## What you can ask");
    expect(markdown).toContain("## Troubleshooting & disconnecting");
    expect(markdown).not.toContain("—");
  });
});
