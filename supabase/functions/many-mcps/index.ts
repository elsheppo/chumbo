import { createClient } from "@supabase/supabase-js";
import {
  createSupabaseMcp,
  renderResult,
  type SupabaseMcpServer,
  toMarkdown,
} from "supa-mcp";
import { z } from "zod";

interface ServerRow {
  slug: string;
  name: string;
  instructions: string;
}

interface ToolRow {
  name: string;
  title: string;
  description: string;
  response: Record<string, unknown>;
  position: number;
}

const projectUrl = Deno.env.get("SUPABASE_URL");
const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
if (!projectUrl || !anonKey) {
  throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY are required");
}
const supabase = createClient(projectUrl, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function serverSlug(request: Request): string | null {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const functionIndex = parts.lastIndexOf("many-mcps");
  return functionIndex >= 0 && parts[functionIndex + 1]
    ? decodeURIComponent(parts[functionIndex + 1])
    : null;
}

async function loadDefinition(slug: string) {
  const [serverResult, toolsResult] = await Promise.all([
    supabase
      .from("reference_servers")
      .select("slug, name, instructions")
      .eq("slug", slug)
      .maybeSingle<ServerRow>(),
    supabase
      .from("reference_tools")
      .select("name, title, description, response, position")
      .eq("server_slug", slug)
      .order("position")
      .returns<ToolRow[]>(),
  ]);
  if (serverResult.error) throw serverResult.error;
  if (toolsResult.error) throw toolsResult.error;
  return serverResult.data
    ? { server: serverResult.data, tools: toolsResult.data ?? [] }
    : null;
}

async function handle(request: Request): Promise<Response> {
  const slug = serverSlug(request);
  if (!slug) {
    return Response.json(
      { error: "Choose a server path such as /many-mcps/directory." },
      { status: 404 },
    );
  }
  const definition = await loadDefinition(slug);
  if (!definition) {
    return Response.json(
      { error: `No enabled MCP named “${slug}”.` },
      {
        status: 404,
      },
    );
  }

  const resourceUrl = new URL(
    `${
      Deno.env.get("MANY_MCPS_PUBLIC_BASE_URL") ??
      `${projectUrl}/functions/v1/many-mcps`
    }/${slug}`,
  );
  const app = createSupabaseMcp({
    server: {
      name: definition.server.name,
      version: "0.5.0",
    },
    resourceUrl,
    auth: { mode: "public", rateLimit: true },
    register(server: SupabaseMcpServer) {
      for (const tool of definition.tools) {
        server.registerTool(
          tool.name,
          {
            title: tool.title,
            description: tool.description,
            inputSchema: z.object({}),
          },
          async () =>
            renderResult(tool.response, (response) =>
              [
                toMarkdown(response),
                "",
                "→ Next: use the returned records in the connected workflow.",
              ].join("\n"),
            ),
        );
      }
    },
  });
  return app.fetch(request);
}

if (import.meta.main) Deno.serve(handle);
export default { fetch: handle };
