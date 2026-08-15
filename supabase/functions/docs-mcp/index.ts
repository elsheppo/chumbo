import {
  createSupabaseMcp,
  errorResult,
  renderResult,
  type SupabaseMcpContext,
  type SupabaseMcpServer,
} from "supa-mcp";
import { z } from "zod";

type DocumentKind = "reference" | "pattern" | "example" | "troubleshooting";

interface ReferenceDocument {
  slug: string;
  kind: DocumentKind;
  title: string;
  summary: string;
  body_markdown: string;
  source_path: string;
  source_url: string;
  package_version: string;
  content_hash: string;
  metadata: Record<string, unknown>;
}

interface ReferenceDatabase {
  public: {
    Tables: {
      reference_documents: {
        Row: ReferenceDocument;
        Insert: ReferenceDocument;
        Update: Partial<ReferenceDocument>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

const projectUrl = Deno.env.get("SUPABASE_URL");
if (!projectUrl) throw new Error("SUPABASE_URL is not configured");

const resourceUrl = new URL(
  Deno.env.get("DOCS_MCP_PUBLIC_URL") ?? `${projectUrl}/functions/v1/docs-mcp`,
);

function renderDocument(document: ReferenceDocument): string {
  return [
    `# ${document.title}`,
    "",
    document.summary,
    "",
    document.body_markdown,
    "",
    `Source: ${document.source_url}`,
    `Package: supa-mcp@${document.package_version}`,
    "",
    "→ Next: use get_example for runnable code, or get_setup_steps for an implementation sequence.",
  ].join("\n");
}

async function getDocument(
  ctx: SupabaseMcpContext<ReferenceDatabase>,
  kind: DocumentKind,
  slug: string,
): Promise<ReferenceDocument | null> {
  const { data, error } = await ctx.supabase
    .from("reference_documents")
    .select(
      "slug, kind, title, summary, body_markdown, source_path, source_url, package_version, content_hash, metadata",
    )
    .eq("kind", kind)
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  return data as unknown as ReferenceDocument | null;
}

function register(
  server: SupabaseMcpServer,
  ctx: SupabaseMcpContext<ReferenceDatabase>,
) {
  server.registerTool(
    "search_docs",
    {
      title: "Search Supa MCP docs",
      description:
        "Search Supa MCP-owned setup guidance, patterns, examples, and troubleshooting. Returns source-linked results; use official Supabase docs for the underlying platform.",
      inputSchema: z.object({
        query: z.string().min(1).describe("What you want to build or resolve."),
        kind: z
          .enum(["reference", "pattern", "example", "troubleshooting"])
          .optional(),
        limit: z.number().int().min(1).max(10).default(5),
      }),
    },
    async ({ query, kind, limit }) => {
      let request = ctx.supabase
        .from("reference_documents")
        .select(
          "slug, kind, title, summary, source_path, source_url, package_version",
        )
        .textSearch("search_document", query, {
          config: "english",
          type: "websearch",
        })
        .limit(limit);
      if (kind) request = request.eq("kind", kind);
      const { data, error } = await request;
      if (error) throw error;
      const matches = (data ?? []) as unknown as Array<
        Pick<
          ReferenceDocument,
          | "slug"
          | "kind"
          | "title"
          | "summary"
          | "source_path"
          | "source_url"
          | "package_version"
          | "content_hash"
        >
      >;
      return renderResult({ query, matches }, ({ query, matches }) =>
        matches.length === 0
          ? `No Supa MCP documentation matched “${query}”.\n\n→ Next: broaden the query or call get_setup_steps for the supported starting paths.`
          : [
              `## Supa MCP docs — ${matches.length} match${
                matches.length === 1 ? "" : "es"
              }`,
              "",
              ...matches.map(
                (match) =>
                  `- **${match.title}** (${match.kind}/${match.slug}) — ${match.summary}\n  Source: ${match.source_url}`,
              ),
              "",
              "→ Next: call get_pattern or get_example with the most relevant slug.",
            ].join("\n"),
      );
    },
  );

  server.registerTool(
    "get_pattern",
    {
      title: "Get a Supa MCP pattern",
      description:
        "Read one tested Supa MCP implementation pattern, including its runnable example and source links.",
      inputSchema: z.object({ slug: z.string().min(1) }),
    },
    async ({ slug }) => {
      const document = await getDocument(ctx, "pattern", slug);
      return document
        ? renderResult(document, renderDocument)
        : errorResult(
            `No Supa MCP pattern named “${slug}” exists.`,
            "call search_docs with the capability you want to build.",
          );
    },
  );

  server.registerTool(
    "get_example",
    {
      title: "Get a runnable example",
      description:
        "Read one executable Supa MCP example with its endpoint, source, tests, and expected behavior.",
      inputSchema: z.object({ slug: z.string().min(1) }),
    },
    async ({ slug }) => {
      const document = await getDocument(ctx, "example", slug);
      return document
        ? renderResult(document, renderDocument)
        : errorResult(
            `No Supa MCP example named “${slug}” exists.`,
            "call search_docs with kind “example” to list relevant examples.",
          );
    },
  );

  server.registerTool(
    "get_setup_steps",
    {
      title: "Get implementation steps",
      description:
        "Get the short, agent-ready setup sequence for one MCP or a named advanced pattern.",
      inputSchema: z.object({
        pattern: z.string().min(1).optional(),
      }),
    },
    async ({ pattern }) => {
      const base = await getDocument(ctx, "reference", "getting-started");
      const selected = pattern
        ? await getDocument(ctx, "pattern", pattern)
        : null;
      if (!base) {
        return errorResult(
          "The getting-started reference has not been synced.",
          "run pnpm reference:content and retry.",
        );
      }
      if (pattern && !selected) {
        return errorResult(
          `No Supa MCP pattern named “${pattern}” exists.`,
          "call search_docs to find a supported pattern slug.",
        );
      }
      const payload = { gettingStarted: base, pattern: selected };
      return renderResult(payload, ({ gettingStarted, pattern }) =>
        [
          renderDocument(gettingStarted),
          ...(pattern ? ["", "---", "", renderDocument(pattern)] : []),
        ].join("\n"),
      );
    },
  );
}

const app = createSupabaseMcp<ReferenceDatabase>({
  server: {
    name: "Supa MCP documentation",
    version: "0.3.0",
  },
  resourceUrl,
  auth: { mode: "public", rateLimit: true },
  register,
});

if (import.meta.main) Deno.serve(app.fetch);
export default app;
