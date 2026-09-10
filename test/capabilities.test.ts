import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CHUMBO_CAPABILITY_META_KEY,
  cliCapabilities,
  defineCapability,
  invocationNeedsConfirmation,
  parseCliInvocation,
  registerCapability,
  structuredResult,
} from "../src/index.js";
import type { SupabaseMcpServer } from "../src/types.js";

describe("capability projection", () => {
  it("lowers one definition to scoped ordinary MCP metadata", () => {
    const handler = vi.fn(async ({ projectId }: { projectId: string }) =>
      structuredResult({ projectId }),
    );
    const capability = defineCapability({
      id: "projects.list",
      mcpName: "list_projects",
      title: "List projects",
      description: "List projects visible to the signed-in user.",
      inputSchema: z.object({ projectId: z.string() }),
      outputSchema: z.object({ projectId: z.string() }),
      scopes: ["projects:read"],
      risk: "read",
      idempotent: true,
      cli: { command: ["projects", "list"], presentation: "json" },
      handler,
    });
    const registerTool = vi.fn((..._args: unknown[]) => ({ enabled: true }));
    const scoped = { registerTool };
    const withScopes = vi.fn(() => scoped);

    registerCapability(
      { withScopes } as unknown as SupabaseMcpServer,
      capability,
    );

    expect(withScopes).toHaveBeenCalledWith(["projects:read"]);
    expect(registerTool).toHaveBeenCalledOnce();
    const [name, config, registeredHandler] = registerTool.mock.calls[0]!;
    expect(name).toBe("list_projects");
    expect(registeredHandler).toBe(handler);
    expect(config).toMatchObject({
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      _meta: {
        [CHUMBO_CAPABILITY_META_KEY]: {
          schemaVersion: 1,
          id: "projects.list",
          mcpName: "list_projects",
          scopes: ["projects:read"],
          risk: "read",
          idempotent: true,
          cli: { command: ["projects", "list"], presentation: "json" },
        },
      },
    });
  });

  it("rejects contradictory safety metadata", () => {
    expect(() =>
      defineCapability({
        id: "projects.delete",
        mcpName: "delete_project",
        description: "Delete a project.",
        risk: "destructive",
        annotations: { readOnlyHint: true },
        cli: { command: ["projects", "delete"] },
        handler: async () => structuredResult({ deleted: true }),
      }),
    ).toThrow(/read-only/);
  });

  it("discovers authored commands and coerces schema-backed flags", () => {
    const tools = cliCapabilities([
      {
        name: "create_task",
        title: "Create task",
        inputSchema: {
          type: "object",
          properties: {
            project_id: { type: "string" },
            priority: { type: "integer" },
            notify: { type: "boolean" },
          },
          required: ["project_id"],
        },
        _meta: {
          [CHUMBO_CAPABILITY_META_KEY]: {
            schemaVersion: 1,
            id: "tasks.create",
            mcpName: "create_task",
            risk: "write",
            idempotent: false,
            scopes: ["tasks:write"],
            cli: { command: ["tasks", "create"] },
          },
        },
      },
    ]);
    const invocation = parseCliInvocation(tools, [
      "tasks",
      "create",
      "--project-id",
      "p1",
      "--priority",
      "2",
      "--notify",
      "true",
      "--json",
    ]);

    expect(invocation.arguments).toEqual({
      project_id: "p1",
      priority: 2,
      notify: true,
    });
    expect(invocation.json).toBe(true);
    expect(invocationNeedsConfirmation(invocation)).toBe(true);
  });

  it("keeps legacy MCP tools reachable through an explicit raw fallback", () => {
    const [capability] = cliCapabilities([
      {
        name: "legacy_ping",
        description: "Ping the service.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
    ]);

    expect(capability).toMatchObject({
      command: ["run", "legacy_ping"],
      risk: "read",
      authored: false,
    });
    expect(
      parseCliInvocation([capability!], ["run", "legacy_ping", "--args", "{}"])
        .arguments,
    ).toEqual({});
  });

  it("rejects duplicate paths and missing required inputs", () => {
    const descriptor = {
      name: "one",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      _meta: {
        [CHUMBO_CAPABILITY_META_KEY]: {
          schemaVersion: 1 as const,
          id: "items.one",
          mcpName: "one",
          risk: "read" as const,
          idempotent: true,
          scopes: [],
          cli: { command: ["items", "get"] },
        },
      },
    };
    const capabilities = cliCapabilities([descriptor]);
    expect(() => parseCliInvocation(capabilities, ["items", "get"])).toThrow(
      /Missing required options: id/,
    );
    expect(() =>
      cliCapabilities([
        descriptor,
        {
          ...descriptor,
          name: "two",
          _meta: {
            [CHUMBO_CAPABILITY_META_KEY]: {
              ...descriptor._meta[CHUMBO_CAPABILITY_META_KEY],
              id: "items.two",
              mcpName: "two",
            },
          },
        },
      ]),
    ).toThrow(/Duplicate CLI command/);
  });
});
