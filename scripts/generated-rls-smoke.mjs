import { execFileSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repository,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    stdio: options.stdio ?? "pipe",
  });
}

const requiredEnvironment = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_JWKS_URL",
];
for (const name of requiredEnvironment) {
  if (!process.env[name]) {
    throw new Error(`Generated RLS smoke requires ${name}`);
  }
}
const fixture = await mkdtemp(join(tmpdir(), "chumbo-generated-rls-"));

try {
  const packed = JSON.parse(
    run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", fixture],
      { env: { npm_config_dry_run: "false" } },
    ),
  )[0];
  const tarball = join(fixture, packed.filename);
  run("tar", ["-xzf", tarball, "-C", fixture]);
  const packageRoot = join(fixture, "package");
  const consumer = join(fixture, "consumer");
  await mkdir(join(consumer, "supabase"), { recursive: true });
  await writeFile(
    join(consumer, "supabase", "config.toml"),
    'project_id = "generated-rls-smoke"\n',
  );

  run(
    process.execPath,
    [
      join(packageRoot, "dist", "cli.js"),
      "init",
      "--yes",
      "--function",
      "mcp",
      "--server-name",
      "Generated RLS smoke",
      "--auth",
      "bearer",
    ],
    { cwd: consumer },
  );

  const functionDirectory = join(consumer, "supabase", "functions", "mcp");
  const generatedCapabilities = await readFile(
    join(functionDirectory, "capabilities.ts"),
    "utf8",
  );
  if (
    (generatedCapabilities.match(/server\.registerTool\(/g) ?? []).length !==
      1 ||
    !generatedCapabilities.includes('"whoami"')
  ) {
    throw new Error("Packed CLI did not generate the compact starter");
  }

  await writeFile(
    join(functionDirectory, "capabilities.ts"),
    `import {
  renderResult,
  type SupabaseMcpContext,
  type SupabaseMcpServer,
} from "chumbo";
import { z } from "zod";

interface DemoDatabase {
  public: {
    Tables: {
      demo_projects: {
        Row: {
          id: string;
          owner_id: string;
          name: string;
          status: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          owner_id: string;
          name: string;
          status?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          owner_id?: string;
          name?: string;
          status?: string;
          created_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

export function registerCapabilities(
  server: SupabaseMcpServer,
  ctx: SupabaseMcpContext<DemoDatabase>,
): void {
  server.registerTool(
    "list_projects",
    {
      description: "List projects visible to the connected Supabase user.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        projects: z.array(z.object({
          id: z.string(),
          name: z.string(),
          status: z.string(),
        })),
      }),
    },
    async () => {
      const { data, error } = await ctx.supabase
        .from("demo_projects")
        .select("id, name, status")
        .order("name");
      if (error) throw error;
      const projects = data ?? [];
      return renderResult({ projects }, ({ projects }) =>
        projects.length === 0
          ? "No projects are visible to this user.\\n\\n→ Next: create a project in the application, then call list_projects again."
          : [
              \`## Visible projects – \${projects.length}\`,
              ...projects.map((project) => \`- **\${project.name}** – \${project.status}\`),
            ].join("\\n"),
      );
    },
  );
}
`,
  );

  const nodeModules = join(consumer, "node_modules");
  await mkdir(nodeModules, { recursive: true });
  await cp(packageRoot, join(nodeModules, "chumbo"), { recursive: true });
  for (const dependency of [
    "@modelcontextprotocol/server",
    "@supabase/server",
    "@supabase/supabase-js",
    "zod",
  ]) {
    const destination = join(nodeModules, dependency);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(
      join(repository, "node_modules", dependency),
      destination,
      "dir",
    );
  }

  const denoPath = join(functionDirectory, "deno.json");
  const denoConfig = JSON.parse(await readFile(denoPath, "utf8"));
  delete denoConfig.imports.chumbo;
  denoConfig.nodeModulesDir = "manual";
  await writeFile(denoPath, `${JSON.stringify(denoConfig, null, 2)}\n`);

  await writeFile(
    join(functionDirectory, "held_out_rls_test.ts"),
    `import { createClient } from "@supabase/supabase-js";
import app from "./index.ts";

const projectUrl = Deno.env.get("SUPABASE_URL");
const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!projectUrl || !anonKey || !serviceRoleKey) {
  throw new Error("Local Supabase environment is incomplete");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      \`\${label}: expected \${JSON.stringify(expected)}, received \${JSON.stringify(actual)}\`,
    );
  }
}

function mcpRequest(
  method: string,
  params: Record<string, unknown>,
  token?: string,
): Request {
  const headers = new Headers({
    "content-type": "application/json",
    "mcp-method": method,
    "mcp-protocol-version": "2026-07-28",
  });
  if (token) headers.set("authorization", \`Bearer \${token}\`);
  if (typeof params.name === "string") headers.set("mcp-name", params.name);
  return new Request(\`\${projectUrl}/functions/v1/mcp\`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "generated-rls-smoke",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

async function body(response: Response): Promise<any> {
  const value = await response.json();
  assert(response.ok && !value.error, JSON.stringify(value));
  return value;
}

async function initialize(token: string): Promise<any> {
  const response = await app.fetch(
    new Request(\`\${projectUrl}/functions/v1/mcp\`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: \`Bearer \${token}\`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: {
            name: "generated-rls-smoke",
            version: "1.0.0",
          },
        },
      }),
    }),
  );
  const text = await response.text();
  assert(response.ok, text);
  const payload = text
    .split("\\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  assert(payload, \`initialize returned no SSE payload: \${text}\`);
  const value = JSON.parse(payload);
  assert(!value.error, JSON.stringify(value));
  return value;
}

Deno.test("packed generated consumer preserves Supabase RLS", async () => {
  const admin = createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const suffix = crypto.randomUUID();
  const credentials = ["alice", "bob", "empty"].map((name) => ({
    email: \`generated-\${name}-\${suffix}@chumbo.test\`,
    password: "generated-reference-password",
  }));
  const createdUserIds: string[] = [];
  const users: Array<{ id: string; token: string }> = [];

  try {
    for (const credential of credentials) {
      const { data: created, error: createError } =
        await admin.auth.admin.createUser({
          ...credential,
          email_confirm: true,
        });
      if (createError) throw createError;
      assert(created.user, \`created user \${credential.email}\`);
      createdUserIds.push(created.user.id);

      const client = createClient(projectUrl, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: signedIn, error: signInError } =
        await client.auth.signInWithPassword(credential);
      if (signInError) throw signInError;
      assert(signedIn.session?.access_token, \`token for \${credential.email}\`);
      users.push({
        id: created.user.id,
        token: signedIn.session.access_token,
      });
    }

    const { error: insertError } = await admin.from("demo_projects").insert([
      { owner_id: users[0].id, name: "Alice candidate project" },
      { owner_id: users[1].id, name: "Bob candidate project" },
    ]);
    if (insertError) throw insertError;

    const denied = await app.fetch(mcpRequest("tools/list", {}));
    equal(denied.status, 401, "missing bearer token is denied");

    const discovery = await body(
      await app.fetch(mcpRequest("tools/list", {}, users[0].token)),
    );
    equal(
      discovery.result.tools.map((tool: { name: string }) => tool.name),
      ["list_projects"],
      "builder-edited tool discovery",
    );
    const initialized = await initialize(users[0].token);
    assert(
      initialized.result.instructions.includes(
        "Use the available capabilities according to their descriptions.",
      ),
      "initialize returns capability-agnostic guidance",
    );
    assert(
      !initialized.result.instructions.includes("whoami"),
      "initialize does not name the replaced starter",
    );

    const invoke = (token: string) =>
      app
        .fetch(
          mcpRequest(
            "tools/call",
            { name: "list_projects", arguments: {} },
            token,
          ),
        )
        .then(body);
    const alice = await invoke(users[0].token);
    const bob = await invoke(users[1].token);
    const empty = await invoke(users[2].token);
    equal(
      alice.result.structuredContent.projects.map(
        (project: { name: string }) => project.name,
      ),
      ["Alice candidate project"],
      "Alice RLS slice",
    );
    equal(
      bob.result.structuredContent.projects.map(
        (project: { name: string }) => project.name,
      ),
      ["Bob candidate project"],
      "Bob RLS slice",
    );
    equal(empty.result.structuredContent.projects, [], "empty RLS slice");
    assert(
      empty.result.content[0].text.includes("→ Next:"),
      "empty state includes a next action",
    );
  } finally {
    if (createdUserIds.length > 0) {
      await admin.from("demo_projects").delete().in(
        "owner_id",
        createdUserIds,
      );
    }
    for (const userId of createdUserIds) {
      await admin.auth.admin.deleteUser(userId);
    }
  }
});
`,
  );

  run("deno", ["task", "check"], { cwd: functionDirectory });
  run(
    "deno",
    [
      "test",
      "--allow-env",
      "--allow-net=127.0.0.1,localhost",
      "held_out_rls_test.ts",
    ],
    { cwd: functionDirectory },
  );

  console.log(
    "Packed generated consumer passed authenticated discovery, invocation, and RLS isolation.",
  );
} finally {
  await rm(fixture, { recursive: true, force: true });
}
