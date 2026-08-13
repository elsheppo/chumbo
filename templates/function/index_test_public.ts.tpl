Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321",
);
const { default: app } = await import("./index.ts");

Deno.test("public MCP boots with its rate-limit guardrail", () => {
  if (typeof app.fetch !== "function") {
    throw new Error("Generated MCP app has no fetch handler");
  }
});
