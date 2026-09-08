import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/client";
import {
  InMemoryTransport,
  McpServer,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { defineCapability, registerCapability } from "../src/capabilities.js";
import {
  createBrandedCli,
  type BrandedCliConnection,
  type BrandedCliConnector,
} from "../src/cli-host.js";
import { structuredResult } from "../src/results.js";
import type { SupabaseMcpServer } from "../src/types.js";

describe("MCP and branded CLI execution identity", () => {
  it("routes both surfaces to the same registered application handler", async () => {
    const applicationHandler = vi.fn(async ({ id }: { id: string }) =>
      structuredResult({ id, owner: "user-1" }),
    );
    const server = new McpServer({ name: "acme", version: "1.0.0" });
    const scoped = server as SupabaseMcpServer;
    scoped.withScopes = () => scoped;
    registerCapability(
      scoped,
      defineCapability({
        id: "projects.get",
        mcpName: "get_project",
        title: "Get project",
        description: "Get one project visible to the signed-in user.",
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ id: z.string(), owner: z.string() }),
        scopes: ["projects:read"],
        risk: "read",
        idempotent: true,
        cli: { command: ["projects", "get"] },
        handler: applicationHandler,
      }),
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "held-out", version: "1.0.0" });
    await client.connect(clientTransport);

    const direct = await client.callTool({
      name: "get_project",
      arguments: { id: "direct" },
    });
    const output: string[] = [];
    const connection: BrandedCliConnection = {
      async listTools() {
        const listed = await client.listTools();
        return { tools: listed.tools };
      },
      callTool(input) {
        return client.callTool(input) as Promise<CallToolResult>;
      },
      async close() {},
    };
    const connector: BrandedCliConnector = {
      async connect() {
        return connection;
      },
      async loggedInIssuer() {
        return "https://project.supabase.co/auth/v1";
      },
      async logout() {},
    };
    const cli = createBrandedCli(
      {
        packageName: "@acme/ops-cli",
        binaryName: "acme",
        displayName: "Acme Ops",
        version: "1.0.0",
        endpoint: "https://api.acme.example/mcp",
      },
      {
        connector,
        io: {
          stdout(value) {
            output.push(value);
          },
          stderr(value) {
            output.push(value);
          },
          isTTY: false,
          async confirm() {
            return false;
          },
        },
      },
    );

    expect(await cli.run(["projects", "get", "--id", "cli", "--json"])).toBe(0);
    expect(direct.structuredContent).toEqual({ id: "direct", owner: "user-1" });
    expect(JSON.parse(output[0]!).result.structuredContent).toEqual({
      id: "cli",
      owner: "user-1",
    });
    expect(applicationHandler).toHaveBeenNthCalledWith(
      1,
      { id: "direct" },
      expect.anything(),
    );
    expect(applicationHandler).toHaveBeenNthCalledWith(
      2,
      { id: "cli" },
      expect.anything(),
    );

    await client.close();
    await server.close();
  });
});
