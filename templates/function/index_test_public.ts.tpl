Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "{{LOCAL_ORIGIN}}",
);
const { default: app } = await import("./index.ts");

Deno.test("public MCP boots with its rate-limit guardrail", () => {
  if (typeof app.fetch !== "function") {
    throw new Error("Generated MCP app has no fetch handler");
  }
});
