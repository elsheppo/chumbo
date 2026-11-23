import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planCloudPatch } from "../src/cloud-setup.js";
import {
  inspectMcpEntrySource,
  planOfficialAdoption,
} from "../src/official-adoption.js";
import {
  detectGeneratedScaffold,
  inspectGeneratedAuthAt,
} from "../src/setup.js";

const ON_EVENT_SNIPPET = `export async function chumboCloudOnEvent() { return "CHUMBO_CLOUD_ANALYTICS_BRIDGE_HMAC_V1"; }`;
const ON_SURFACE_SNIPPET = `export async function chumboCloudOnSurface() { return "CHUMBO_CLOUD_ANALYTICS_BRIDGE_HMAC_V1"; }`;

const OFFICIAL_PIPELINE_SOURCE = `import { pipeline } from "npm:@supabase/middleware@1.0.0";
import { withOAuthProtectedResource, withSupabase } from "npm:@supabase/server@1.9.2";
import { createMcpHandler, McpServer } from "npm:@modelcontextprotocol/server@2.0.0";

Deno.serve(
  pipeline(
    [
      withOAuthProtectedResource(),
      withSupabase({ auth: "user" }),
    ],
    async (req, ctx) => {
      const handler = createMcpHandler(() => {
        const server = new McpServer({ name: "todos", version: "1.0.0" });
        return server;
      });
      return handler.fetch(req);
    },
  ),
);
`;

const OFFICIAL_NESTED_SOURCE = `import { withOAuthProtectedResource, withSupabase } from "@supabase/server";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

async function handleMcp(req: Request) {
  const handler = createMcpHandler(() => new McpServer({ name: "todos", version: "1.0.0" }));
  return handler.fetch(req);
}

export const POST = withOAuthProtectedResource(
  withSupabase({ auth: "user" }, handleMcp),
);
`;

describe("official @supabase/server MCP detection and adoption", () => {
  it("ignores commented-out runtime calls and classifies chumbo-app, chumbo-pipeline, and supabase-official accurately", () => {
    const commentedOnly = `
// createSupabaseMcp({ auth: { mode: "public" } })
/* withSupabase({ auth: "user" }) */
export default function noop() {}
`;
    expect(inspectMcpEntrySource(commentedOnly)).toBeUndefined();

    const official = inspectMcpEntrySource(OFFICIAL_PIPELINE_SOURCE);
    expect(official).toMatchObject({
      kind: "supabase-official",
      mode: "oauth",
      adoptable: true,
    });

    const bearerOfficial = inspectMcpEntrySource(
      OFFICIAL_PIPELINE_SOURCE.replace("withOAuthProtectedResource(),", ""),
    );
    expect(bearerOfficial).toMatchObject({
      kind: "supabase-official",
      mode: "bearer",
      adoptable: true,
    });

    const secretOfficial = inspectMcpEntrySource(
      OFFICIAL_PIPELINE_SOURCE.replace('auth: "user"', 'auth: "secret"'),
    );
    expect(secretOfficial).toMatchObject({
      kind: "supabase-official",
      mode: "api-key",
      apiKeyStrategy: "static",
      adoptable: true,
    });

    const pipelineAdopted = inspectMcpEntrySource(`
import { pipeline } from "@supabase/middleware";
import { withSupabase } from "@supabase/server";
import { withChumbo } from "chumbo/middleware";

Deno.serve(
  pipeline([withSupabase({ auth: "none" }), withChumbo({ server: { name: "x", version: "1.0.0" } })], h),
);
`);
    expect(pipelineAdopted).toMatchObject({
      kind: "chumbo-pipeline",
      mode: "public",
    });
  });

  it("surgically adopts Form A pipeline([...], inlineHandler) and instruments new McpServer(...)", () => {
    const plan = planOfficialAdoption({
      entryPath: "supabase/functions/mcp/index.ts",
      currentSource: OFFICIAL_PIPELINE_SOURCE,
      serverName: "acme-todos",
      packageVersion: "0.15.0",
    });

    expect(plan.status).toBe("update");
    expect(plan.adoptable).toBe(true);
    expect(plan.instrumentedServer).toBe(true);
    expect(plan.source).toContain(
      'import { withChumbo } from "npm:chumbo@0.15.0/middleware";',
    );
    expect(plan.source).toContain(
      'withChumbo({\n    server: { name: "acme-todos", version: "1.0.0" },',
    );
    expect(plan.source).toContain(
      'ctx.chumbo.instrument(new McpServer({ name: "todos", version: "1.0.0" }))',
    );
    // Re-inspecting the adopted source classifies it as chumbo-pipeline.
    expect(inspectMcpEntrySource(plan.source)).toMatchObject({
      kind: "chumbo-pipeline",
      mode: "oauth",
    });
  });

  it("surgically adopts Form B nested withSupabase(config, handleMcp) and emits an advisory tip", () => {
    const plan = planOfficialAdoption({
      entryPath: "app/mcp/[[...path]]/route.ts",
      currentSource: OFFICIAL_NESTED_SOURCE,
      serverName: "acme-todos",
      usesBareNpmSpecifiers: false,
    });

    expect(plan.status).toBe("update");
    expect(plan.adoptable).toBe(true);
    expect(plan.instrumentedServer).toBe(false);
    expect(plan.advisoryTip).toContain("ctx.chumbo.instrument(server)");
    expect(plan.source).toContain(
      'import { withChumbo } from "chumbo/middleware";',
    );
    expect(plan.source).toContain('withSupabase({ auth: "user" }, withChumbo(');
    expect(plan.source).toContain(", handleMcp))");
  });

  it("fails closed with conflict and zero mutation when pipeline([...]) uses a dynamic spread", () => {
    const spreadSource = `import { pipeline } from "@supabase/middleware";
import { withSupabase } from "@supabase/server";
import { McpServer } from "@modelcontextprotocol/server";

const custom = [];
Deno.serve(
  pipeline([...custom, withSupabase({ auth: "user" })], async () => {
    new McpServer({ name: "x", version: "1.0.0" });
    return new Response("ok");
  }),
);
`;
    const plan = planOfficialAdoption({
      entryPath: "supabase/functions/mcp/index.ts",
      currentSource: spreadSource,
      serverName: "acme",
    });

    expect(plan.status).toBe("conflict");
    expect(plan.adoptable).toBe(false);
    expect(plan.source).toBe(spreadSource);
    expect(plan.blocker).toContain("spread");
    expect(plan.manualSnippet).toContain("withChumbo(");
  });

  it("detects chumbo-pipeline and supabase-official scaffolds across Next and Node targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "chumbo-adoption-"));
    const nextRoute = join(root, "app", "mcp", "[[...path]]", "route.ts");
    await mkdir(join(root, "app", "mcp", "[[...path]]"), { recursive: true });
    await writeFile(nextRoute, OFFICIAL_NESTED_SOURCE, "utf8");

    const detected = await detectGeneratedScaffold(root, "mcp");
    expect(detected).toEqual({ target: "next", entryPath: nextRoute });
    expect(await inspectGeneratedAuthAt(nextRoute)).toEqual({ mode: "oauth" });
  });

  it("patches both withChumbo(...) (preserving composeEventSinks) and supabase-official entries in planCloudPatch", () => {
    // 1. Official block adopted in one shot with Cloud sinks.
    const officialPatch = planCloudPatch({
      root: "/project",
      functionSlug: "mcp",
      currentSource: OFFICIAL_PIPELINE_SOURCE,
      currentAdapter: null,
      onEventSnippet: ON_EVENT_SNIPPET,
      onSurfaceSnippet: ON_SURFACE_SNIPPET,
    });
    expect(officialPatch.changed).toBe(true);
    expect(officialPatch.functionSource).toContain("withChumbo({");
    expect(officialPatch.functionSource).toContain(
      "onEvent: chumboCloudOnEvent,",
    );
    expect(officialPatch.functionSource).toContain(
      "onSurface: chumboCloudOnSurface,",
    );
    expect(officialPatch.functionSource).toContain(
      'import { chumboCloudOnEvent, chumboCloudOnSurface } from "./chumbo-cloud.ts";',
    );

    // 2. Existing withChumbo({...}) with custom onEvent preserves composeEventSinks.
    const existingPipeline = `import { pipeline } from "@supabase/middleware";
import { withSupabase } from "@supabase/server";
import { withChumbo } from "chumbo/middleware";

Deno.serve(
  pipeline(
    [
      withSupabase({ auth: "user" }),
      withChumbo({
        server: { name: "mcp", version: "1.0.0" },
        onEvent: localInsightsSink,
      }),
    ],
    handleMcp,
  ),
);
`;
    const composedPatch = planCloudPatch({
      root: "/project",
      functionSlug: "mcp",
      currentSource: existingPipeline,
      currentAdapter: null,
      onEventSnippet: ON_EVENT_SNIPPET,
      onSurfaceSnippet: ON_SURFACE_SNIPPET,
    });
    expect(composedPatch.changed).toBe(true);
    expect(composedPatch.functionSource).toContain(
      'import { composeEventSinks } from "chumbo/insights";',
    );
    expect(composedPatch.functionSource).toContain(
      "composeEventSinks(localInsightsSink, chumboCloudOnEvent)",
    );
    expect(composedPatch.functionSource).toContain(
      "onSurface: chumboCloudOnSurface,",
    );
  });
});
