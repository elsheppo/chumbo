import {
  createSupabaseMcp,
  errorResult,
  resourceResult,
  type SupabaseMcpContext,
  type SupabaseMcpServer,
} from "supa-mcp";
import {
  ResourceTemplate,
  type ResourceLink,
} from "@modelcontextprotocol/server";
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

function documentUri(document: Pick<ReferenceDocument, "kind" | "slug">) {
  return `supa-mcp://docs/${document.kind}/${encodeURIComponent(document.slug)}`;
}

function documentMeta(document: ReferenceDocument) {
  return {
    sourceUrl: document.source_url,
    sourcePath: document.source_path,
    packageVersion: document.package_version,
    contentHash: document.content_hash,
    ...document.metadata,
  };
}

function documentLink(document: ReferenceDocument): ResourceLink {
  return {
    type: "resource_link",
    uri: documentUri(document),
    name: `${document.kind}-${document.slug}`,
    title: document.title,
    description: document.summary,
    mimeType: "text/markdown",
    size: new TextEncoder().encode(document.body_markdown).byteLength,
    _meta: documentMeta(document),
  };
}

function documentCard(document: ReferenceDocument): string {
  return [
    `# ${document.title}`,
    "",
    document.summary,
    "",
    `Source: ${document.source_url}`,
    `Package: supa-mcp@${document.package_version}`,
    "",
    "→ Next: read the linked MCP resource for the complete document.",
  ].join("\n");
}

const documentInputSchema = z.object({ slug: z.string().min(1) });

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
  server.registerResource(
    "supa-mcp-document",
    new ResourceTemplate("supa-mcp://docs/{kind}/{slug}", {
      list: async () => {
        const { data, error } = await ctx.supabase
          .from("reference_documents")
          .select(
            "slug, kind, title, summary, body_markdown, source_path, source_url, package_version, content_hash, metadata",
          )
          .order("kind")
          .order("slug");
        if (error) throw error;
        const documents = (data ?? []) as unknown as ReferenceDocument[];
        return {
          resources: documents.map((document) => ({
            uri: documentUri(document),
            name: `${document.kind}-${document.slug}`,
            title: document.title,
            description: document.summary,
            mimeType: "text/markdown",
            size: new TextEncoder().encode(document.body_markdown).byteLength,
            _meta: documentMeta(document),
          })),
        };
      },
    }),
    {
      title: "Supa MCP document",
      description:
        "A complete Supa MCP-owned reference, pattern, example, or troubleshooting document.",
      mimeType: "text/markdown",
      cacheHint: { cacheScope: "public", ttlMs: 60_000 },
    },
    async (uri, variables) => {
      const kind = String(variables.kind) as DocumentKind;
      const slug = String(variables.slug);
      const document = await getDocument(ctx, kind, slug);
      return {
        contents: document
          ? [
              {
                uri: uri.href,
                mimeType: "text/markdown",
                text: document.body_markdown,
                _meta: documentMeta(document),
              },
            ]
          : [],
      };
    },
  );

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
          "slug, kind, title, summary, body_markdown, source_path, source_url, package_version, content_hash, metadata",
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
      if (matches.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No Supa MCP documentation matched “${query}”.\n\n→ Next: broaden the query or call get_setup_steps for the supported starting paths.`,
            },
          ],
        };
      }
      const documents = matches as unknown as ReferenceDocument[];
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `## Supa MCP docs — ${matches.length} match${matches.length === 1 ? "" : "es"}`,
              "",
              ...matches.map(
                (match) =>
                  `- **${match.title}** (${match.kind}/${match.slug}) — ${match.summary}`,
              ),
              "",
              "→ Next: read the most relevant linked resource.",
            ].join("\n"),
          },
          ...documents.map(documentLink),
        ],
      };
    },
  );

  server.registerTool(
    "get_reference",
    {
      title: "Get Supa MCP reference guidance",
      description:
        "Read one Supa MCP-owned reference document by slug, such as auth-modes, connect-clients, or getting-started.",
      inputSchema: documentInputSchema,
    },
    async ({ slug }) => {
      const document = await getDocument(ctx, "reference", slug);
      return document
        ? resourceResult(documentCard(document), documentLink(document))
        : errorResult(
            `No Supa MCP reference named “${slug}” exists.`,
            "call search_docs with kind “reference” to list relevant guidance.",
          );
    },
  );

  server.registerTool(
    "get_pattern",
    {
      title: "Get a Supa MCP pattern",
      description:
        "Read one tested Supa MCP implementation pattern, including its runnable example and source links.",
      inputSchema: documentInputSchema,
    },
    async ({ slug }) => {
      const document = await getDocument(ctx, "pattern", slug);
      return document
        ? resourceResult(documentCard(document), documentLink(document))
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
      inputSchema: documentInputSchema,
    },
    async ({ slug }) => {
      const document = await getDocument(ctx, "example", slug);
      return document
        ? resourceResult(documentCard(document), documentLink(document))
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
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `# ${base.title}`,
              "",
              base.summary,
              ...(selected
                ? ["", `Pattern: ${selected.title} — ${selected.summary}`]
                : []),
              "",
              "→ Next: read the linked resources and implement their tested sequence.",
            ].join("\n"),
          },
          documentLink(base),
          ...(selected ? [documentLink(selected)] : []),
        ],
      };
    },
  );
}

const app = createSupabaseMcp<ReferenceDatabase>({
  server: {
    name: "Supa MCP documentation",
    version: "0.7.0",
  },
  resourceUrl,
  auth: { mode: "public", rateLimit: true },
  register,
});

if (import.meta.main) Deno.serve(app.fetch);
export default app;
