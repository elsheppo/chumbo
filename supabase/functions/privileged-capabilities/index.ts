import {
  createSupabaseMcp,
  renderResult,
  type SupabaseMcpContext,
  type SupabaseMcpServer,
} from "chumbo";
import { z } from "zod";

interface ReferenceDatabase {
  public: {
    Tables: {
      reference_api_keys: {
        Row: {
          token_hash: string;
          subject: string;
          scopes: string[];
          revoked_at: string | null;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

const projectUrl = Deno.env.get("SUPABASE_URL");
if (!projectUrl) throw new Error("SUPABASE_URL is not configured");

const resourceUrl = new URL(
  Deno.env.get("PRIVILEGED_CAPABILITIES_PUBLIC_URL") ??
    `${projectUrl}/functions/v1/privileged-capabilities`,
);

function register(
  server: SupabaseMcpServer,
  ctx: SupabaseMcpContext<ReferenceDatabase>,
) {
  server.withScopes(["catalog:read"]).registerTool(
    "list_catalog",
    {
      title: "List the example catalog",
      description:
        "Read the public example catalog available to signed-in users.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        items: z.array(z.object({ id: z.string(), title: z.string() })),
      }),
    },
    async () =>
      renderResult(
        { items: [{ id: "example-1", title: "Reference item" }] },
        ({ items }) =>
          `## Catalog\n\n${items.map((item) => `- **${item.title}** – ${item.id}`).join("\n")}\n\n→ Next: choose an item to inspect in your application.`,
      ),
  );

  server.withScopes(["catalog:publish"]).registerTool(
    "preview_publication",
    {
      title: "Preview a privileged publication",
      description:
        "Owner-only demonstration tool. Preview a publication without mutating reference data.",
      inputSchema: z.object({ title: z.string().min(1) }),
      outputSchema: z.object({
        title: z.string(),
        publisher: z.string(),
        status: z.literal("preview"),
      }),
    },
    async ({ title }) =>
      renderResult(
        { title, publisher: ctx.subject, status: "preview" },
        (preview) =>
          `## Publication preview\n\n**${preview.title}** · ${preview.status}\nPublisher: ${preview.publisher}\n\n→ Next: use the equivalent application-owned tool to perform the real mutation.`,
      ),
  );

  server
    .withScopes(["catalog:read"])
    .registerResource(
      "catalog-guide",
      "supa-mcp://catalog/guide",
      { mimeType: "text/markdown" },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            text: "# Catalog guide\n\nSigned-in users can read the catalog.",
          },
        ],
      }),
    );

  server.withScopes(["catalog:publish"]).registerPrompt(
    "plan_publication",
    {
      description: "Owner-only prompt for planning a catalog publication.",
      argsSchema: z.object({ title: z.string().min(1) }),
    },
    ({ title }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Plan a publication for ${title}. Do not publish without an explicit tool call.`,
          },
        },
      ],
    }),
  );
}

const app = createSupabaseMcp<ReferenceDatabase>({
  server: { name: "Chumbo privileged capabilities", version: "0.8.0" },
  instructions: (ctx) =>
    ctx.hasScope("catalog:publish")
      ? "You may read the catalog and preview owner-only publications. Mutations still require an explicit tool call."
      : "You may read the catalog. Publishing capabilities are not available to this identity.",
  resourceUrl,
  auth: {
    mode: "multi",
    strategies: [
      { mode: "oauth", strategy: "supabase-user" },
      {
        mode: "api-key",
        strategy: "reference-application-key",
        tokenPrefix: "supa_ref_",
        async verify({ token, supabaseAdmin }) {
          const tokenHash = await sha256(token);
          const { data, error } = await supabaseAdmin
            .from("reference_api_keys")
            .select("subject, scopes")
            .eq("token_hash", tokenHash)
            .is("revoked_at", null)
            .maybeSingle();
          if (error) throw error;
          return data
            ? { subject: data.subject, scopes: data.scopes ?? [] }
            : null;
        },
      },
    ],
  },
  access: {
    resolveScopes(ctx) {
      return ctx.authentication.mode === "oauth"
        ? ["catalog:read"]
        : ctx.scopes;
    },
  },
  register,
});

if (import.meta.main) Deno.serve(app.fetch);
export default app;
