// Proves the MCP surface respects the application's RLS policies, using the
// seeded demo users. Requires the local stack (`supabase start`) and runs the
// MCP function in-process, so no function server is needed:
//
//   npm run test:isolation
//
// Keep a test like this for every policy you add: it is the contract that an
// agent connected as one user can never read or change another user's data.

import { createClient } from "@supabase/supabase-js";

const projectUrl = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const publishableKey =
  Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY");
if (!publishableKey) {
  throw new Error(
    "Set SUPABASE_PUBLISHABLE_KEY (see `supabase status`) before running this test.",
  );
}
// The Edge Runtime injects these for deployed and served functions; set them
// so the function can verify Supabase-issued tokens when run in-process.
Deno.env.set("SUPABASE_URL", projectUrl);
Deno.env.set("SUPABASE_PUBLISHABLE_KEY", publishableKey);
if (!Deno.env.get("SUPABASE_JWKS")) {
  const jwks = await fetch(`${projectUrl}/auth/v1/.well-known/jwks.json`);
  if (!jwks.ok)
    throw new Error(
      `Local JWKS returned HTTP ${jwks.status}. Is the stack running?`,
    );
  Deno.env.set("SUPABASE_JWKS", await jwks.text());
}
const { default: app } = await import("../functions/mcp/index.ts");

const TEAMS = {
  aliceStudio: "7ea30000-0000-4000-8000-00000000000a",
  bobGarage: "7ea30000-0000-4000-8000-00000000000b",
  launchCrew: "7ea30000-0000-4000-8000-00000000000c",
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, received ${a}`);
}

async function signIn(email: string) {
  const client = createClient(projectUrl, publishableKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password: "password123",
  });
  if (error) throw error;
  return { client, token: data.session.access_token };
}

async function call(
  token: string | undefined,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ status: number; body: any }> {
  const headers = new Headers({
    "content-type": "application/json",
    "mcp-method": method,
    "mcp-protocol-version": "2026-07-28",
  });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (typeof params.name === "string") headers.set("mcp-name", params.name);
  const response = await app.fetch(
    new Request(`${projectUrl}/functions/v1/mcp`, {
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
              name: "isolation-test",
              version: "1.0.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function tool(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  const { status, body } = await call(token, "tools/call", {
    name,
    arguments: args,
  });
  assert(status === 200 && !body.error, `${name}: ${JSON.stringify(body)}`);
  return body.result;
}

const alice = await signIn("alice@example.com");
const bob = await signIn("bob@example.com");

Deno.test("an unauthenticated client receives an OAuth challenge", async () => {
  const { status } = await call(undefined, "tools/list");
  assertEquals(status, 401, "status");
});

Deno.test("the MCP surface lists the team task tools", async () => {
  const { body } = await call(alice.token, "tools/list");
  assertEquals(
    body.result.tools.map((t: { name: string }) => t.name).sort(),
    ["create_task", "list_tasks", "list_teams", "update_task"],
    "tools",
  );
});

Deno.test("each user sees only their own teams", async () => {
  const names = async (token: string) =>
    (await tool(token, "list_teams")).structuredContent.teams
      .map((team: { name: string }) => team.name)
      .sort();
  assertEquals(
    await names(alice.token),
    ["Alice's Studio", "Launch Crew"],
    "Alice",
  );
  assertEquals(await names(bob.token), ["Bob's Garage", "Launch Crew"], "Bob");
});

Deno.test("each user sees only tasks in their teams", async () => {
  const teamsOf = async (token: string) =>
    [
      ...new Set(
        (
          await tool(token, "list_tasks", { limit: 100 })
        ).structuredContent.items.map((task: { team: string }) => task.team),
      ),
    ].sort();
  assertEquals(
    await teamsOf(alice.token),
    ["Alice's Studio", "Launch Crew"],
    "Alice",
  );
  assertEquals(
    await teamsOf(bob.token),
    ["Bob's Garage", "Launch Crew"],
    "Bob",
  );
});

Deno.test("list_tasks paginates with a stable cursor", async () => {
  const first = (await tool(alice.token, "list_tasks", { limit: 2 }))
    .structuredContent;
  assertEquals(first.items.length, 2, "first page size");
  assert(first.has_more && first.next_call, "first page continues");
  const second = (
    await tool(alice.token, "list_tasks", first.next_call.arguments)
  ).structuredContent;
  const ids = [...first.items, ...second.items].map(
    (task: { id: string }) => task.id,
  );
  assertEquals(new Set(ids).size, ids.length, "no duplicates across pages");
});

Deno.test("a shared team's task is visible to both members", async () => {
  const created = await tool(alice.token, "create_task", {
    team_id: TEAMS.launchCrew,
    title: `Shared task ${crypto.randomUUID()}`,
  });
  const id = created.structuredContent.id;
  try {
    const bobSees = (
      await tool(bob.token, "list_tasks", {
        team_id: TEAMS.launchCrew,
        limit: 100,
      })
    ).structuredContent.items.some((task: { id: string }) => task.id === id);
    assert(bobSees, "Bob sees Alice's task in the shared team");
    const updated = await tool(bob.token, "update_task", {
      id,
      status: "done",
    });
    assertEquals(updated.structuredContent.status, "done", "Bob can update it");
  } finally {
    await alice.client.from("tasks").delete().eq("id", id);
  }
});

Deno.test("creating a task in another user's team is refused", async () => {
  const result = await tool(alice.token, "create_task", {
    team_id: TEAMS.bobGarage,
    title: "Should never exist",
  });
  assert(result.isError, "create_task returns a tool error");
  const { data } = await bob.client
    .from("tasks")
    .select("id")
    .eq("title", "Should never exist");
  assertEquals(data, [], "no row was written");
});

Deno.test("updating another user's private task changes nothing", async () => {
  const { data } = await bob.client
    .from("tasks")
    .select("id, title")
    .eq("team_id", TEAMS.bobGarage)
    .limit(1)
    .single();
  assert(data, "Bob has a private task");
  const result = await tool(alice.token, "update_task", {
    id: data.id,
    title: "Hijacked",
  });
  assert(result.isError, "update_task returns a tool error");
  const { data: after } = await bob.client
    .from("tasks")
    .select("title")
    .eq("id", data.id)
    .single();
  assertEquals(after?.title, data.title, "title unchanged");
});
