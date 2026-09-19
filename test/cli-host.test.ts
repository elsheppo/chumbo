import { describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@modelcontextprotocol/client";
import { CHUMBO_CAPABILITY_META_KEY } from "../src/capabilities.js";
import {
  createBrandedCli,
  type BrandedCliConfig,
  type BrandedCliConnection,
  type BrandedCliConnector,
} from "../src/cli-host.js";

const config: BrandedCliConfig = {
  packageName: "@acme/ops",
  binaryName: "acme",
  displayName: "Acme Ops",
  version: "1.0.0",
  endpoint: "https://api.acme.example/mcp",
  supportUrl: "https://acme.example/support",
  poweredBy: "Chumbo Cloud",
};

const listTool = {
  name: "list_projects",
  title: "List projects",
  description: "List projects visible to you.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
  _meta: {
    [CHUMBO_CAPABILITY_META_KEY]: {
      schemaVersion: 1,
      id: "projects.list",
      mcpName: "list_projects",
      risk: "read",
      idempotent: true,
      scopes: ["projects:read"],
      cli: { command: ["projects", "list"] },
    },
  },
};

const deleteTool = {
  name: "delete_project",
  title: "Delete project",
  description: "Permanently delete a project.",
  inputSchema: {
    type: "object",
    properties: { project_id: { type: "string" } },
    required: ["project_id"],
  },
  annotations: { destructiveHint: true },
  _meta: {
    [CHUMBO_CAPABILITY_META_KEY]: {
      schemaVersion: 1,
      id: "projects.delete",
      mcpName: "delete_project",
      risk: "destructive",
      idempotent: true,
      scopes: ["projects:write"],
      cli: { command: ["projects", "delete"] },
    },
  },
};

function harness(options: { unauthorized?: boolean; tty?: boolean } = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const callTool = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "Project one" }],
    structuredContent: { id: "p1" },
  }));
  const close = vi.fn(async () => {});
  const connection: BrandedCliConnection = {
    async listTools() {
      return { tools: [listTool, deleteTool] };
    },
    callTool,
    close,
  };
  const connector: BrandedCliConnector = {
    async connect() {
      if (options.unauthorized) throw new UnauthorizedError();
      return connection;
    },
    async loggedInIssuer() {
      return "https://project.supabase.co/auth/v1";
    },
    async logout() {},
  };
  const cli = createBrandedCli(config, {
    connector,
    io: {
      stdout(value) {
        stdout.push(value);
      },
      stderr(value) {
        stderr.push(value);
      },
      isTTY: options.tty ?? false,
      async confirm() {
        return true;
      },
    },
  });
  return { cli, stdout, stderr, callTool, close };
}

describe("project-branded CLI host", () => {
  it("renders project identity and authenticated command discovery", async () => {
    const root = harness();
    expect(await root.cli.run([])).toBe(0);
    expect(root.stdout[0]).toContain("Acme Ops CLI");
    expect(root.stdout[0]).toContain("acme login");

    const commands = harness();
    expect(await commands.cli.run(["commands"])).toBe(0);
    expect(commands.stdout[0]).toContain("acme projects list");
    expect(commands.stdout[0]).toContain("acme projects delete");
  });

  it("calls the same advertised MCP tool and emits stable JSON", async () => {
    const run = harness();
    expect(await run.cli.run(["projects", "list", "--json"])).toBe(0);
    expect(run.callTool).toHaveBeenCalledWith({
      name: "list_projects",
      arguments: {},
    });
    expect(JSON.parse(run.stdout[0]!)).toMatchObject({
      ok: true,
      command: ["projects", "list"],
      capabilityId: "projects.list",
      mcpName: "list_projects",
      result: { structuredContent: { id: "p1" } },
    });
  });

  it("fails closed for writes without confirmation in non-interactive use", async () => {
    const run = harness();
    expect(
      await run.cli.run(["projects", "delete", "--project-id", "p1"]),
    ).toBe(4);
    expect(run.callTool).not.toHaveBeenCalled();
    expect(run.stderr[0]).toContain("without --yes");
  });

  it("allows explicitly confirmed writes", async () => {
    const run = harness();
    expect(
      await run.cli.run(["projects", "delete", "--project-id", "p1", "--yes"]),
    ).toBe(0);
    expect(run.callTool).toHaveBeenCalledWith({
      name: "delete_project",
      arguments: { project_id: "p1" },
    });
  });

  it("returns a branded recovery instruction for expired or absent sessions", async () => {
    const run = harness({ unauthorized: true });
    expect(await run.cli.run(["commands"])).toBe(3);
    expect(run.stderr).toEqual(["Sign in required. Run 'acme login'."]);
  });
});
