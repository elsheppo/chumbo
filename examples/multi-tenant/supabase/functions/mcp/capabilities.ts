import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { structuredResult, type SupabaseMcpContext } from "supa-mcp";
import { z } from "zod";

interface ExampleDatabase {
  public: {
    Tables: {
      csm_documents: {
        Row: {
          id: string;
          organization_id: string;
          title: string;
          body: string;
          created_at: string;
        };
      };
    };
  };
}

export function registerCapabilities(
  server: McpServer,
  ctx: SupabaseMcpContext<ExampleDatabase>,
): void {
  server.registerTool(
    "list_documents",
    {
      description: "List documents visible to the connected user through RLS.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        documents: z.array(
          z.object({
            id: z.string(),
            organization_id: z.string(),
            title: z.string(),
            created_at: z.string(),
          }),
        ),
      }),
    },
    async () => {
      const { data, error } = await ctx.supabase
        .from("csm_documents")
        .select("id, organization_id, title, created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return structuredResult({ documents: data ?? [] });
    },
  );

  server.registerResource(
    "document",
    new ResourceTemplate("app://documents/{id}", { list: undefined }),
    {
      title: "Document",
      description: "One RLS-visible document.",
      mimeType: "text/markdown",
      cacheHint: { cacheScope: "private", ttlMs: 30_000 },
    },
    async (uri, variables) => {
      const { data, error } = await ctx.supabase
        .from("csm_documents")
        .select("id, title, body")
        .eq("id", String(variables.id))
        .maybeSingle();
      if (error) throw error;
      return {
        contents: data
          ? [
              {
                uri: uri.href,
                mimeType: "text/markdown",
                text: `# ${data.title}\n\n${data.body}`,
              },
            ]
          : [],
      };
    },
  );
}
