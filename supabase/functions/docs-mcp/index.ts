import {
  createSupabaseMcp,
  collectionInputSchema,
  collectionOutputSchema,
  collectionResult,
  errorResult,
  resourceResult,
  type SupabaseMcpContext,
  type SupabaseMcpServer,
} from "chumbo";
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

const searchCursor = z
  .object({
    version: z.literal(1),
    after: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    query: z.string().min(1).max(500),
    kind: z
      .enum(["reference", "pattern", "example", "troubleshooting"])
      .nullable(),
  })
  .strict();
function parseSearchCursor(value: string) {
  try {
    return searchCursor.safeParse(JSON.parse(value));
  } catch {
    return searchCursor.safeParse(null);
  }
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
      title: "Chumbo document",
      description:
        "A complete Chumbo-owned reference, pattern, example, or troubleshooting document.",
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

  const documentSummary = z.object({
    slug: z.string(),
    kind: z.string(),
    title: z.string(),
    summary: z.string(),
    uri: z.string(),
  });
  server.registerTool(
    "search_docs",
    {
      title: "Search Chumbo docs",
      description:
        "Search Chumbo guidance in stable slug order. Returns compact pages; read a selected uri with resources/read. Changes between calls are live, not a snapshot.",
      inputSchema: collectionInputSchema({
        defaultLimit: 5,
        maxLimit: 10,
        cursorSchema: z
          .string()
          .refine(
            (value) => parseSearchCursor(value).success,
            "Invalid documentation cursor; restart search without cursor.",
          ),
      }).extend({
        query: z
          .string()
          .min(1)
          .max(500)
          .describe("What you want to build or resolve."),
        kind: z
          .enum(["reference", "pattern", "example", "troubleshooting"])
          .optional(),
      }),
      outputSchema: collectionOutputSchema(documentSummary),
    },
    async ({ query, kind, limit, cursor }) => {
      const position = cursor ? parseSearchCursor(cursor) : null;
      if (
        position &&
        (!position.success ||
          position.data.query !== query ||
          position.data.kind !== (kind ?? null))
      ) {
        return errorResult(
          "The documentation cursor belongs to a different search.",
          "restart search_docs with the new query/kind and omit cursor.",
        );
      }
      let request = ctx.supabase
        .from("reference_documents")
        .select("slug, kind, title, summary")
        .textSearch("search_document", query, {
          config: "english",
          type: "websearch",
        })
        .order("slug")
        .limit(limit + 1);
      if (kind) request = request.eq("kind", kind);
      if (position?.success) request = request.gt("slug", position.data.after);
      const { data, error } = await request;
      if (error) throw error;
      const matches = (data ?? []) as Pick<
        ReferenceDocument,
        "slug" | "kind" | "title" | "summary"
      >[];
      return collectionResult({
        items: matches,
        limit,
        maxLimit: 10,
        hasMore: false,
        tool: "search_docs",
        arguments: {
          query,
          ...(kind ? { kind } : {}),
          ...(cursor ? { cursor } : {}),
        },
        itemSchema: documentSummary,
        project: (document) => ({
          slug: document.slug,
          kind: document.kind,
          title: document.title,
          summary: document.summary,
          uri: documentUri(document),
        }),
        cursorFor: (document) =>
          JSON.stringify({
            version: 1,
            after: document.slug,
            query,
            kind: kind ?? null,
          }),
        mode: "hybrid",
        maxBytes: 8000,
        render: ({ items }) =>
          items.length
            ? items
                .map(
                  (item) =>
                    `- **${item.title}** (${item.kind}/${item.slug}) – ${item.summary}\n  Read: ${item.uri}`,
                )
                .join("\n")
            : "No matching Chumbo documentation. Broaden the query or call get_setup_steps.",
        onOversizedItem: (document) =>
          `read ${documentUri(document)} with resources/read for the complete document.`,
      });
    },
  );

  server.registerTool(
    "get_reference",
    {
      title: "Get Chumbo reference guidance",
      description:
        "Read one Chumbo-owned reference document by slug, such as auth-modes, connect-clients, or getting-started.",
      inputSchema: documentInputSchema,
    },
    async ({ slug }) => {
      const document = await getDocument(ctx, "reference", slug);
      return document
        ? resourceResult(documentCard(document), documentLink(document))
        : errorResult(
            `No Chumbo reference named “${slug}” exists.`,
            "call search_docs with kind “reference” to list relevant guidance.",
          );
    },
  );

  server.registerTool(
    "get_pattern",
    {
      title: "Get a Chumbo pattern",
      description:
        "Read one tested Chumbo implementation pattern, including its runnable example and source links.",
      inputSchema: documentInputSchema,
    },
    async ({ slug }) => {
      const document = await getDocument(ctx, "pattern", slug);
      return document
        ? resourceResult(documentCard(document), documentLink(document))
        : errorResult(
            `No Chumbo pattern named “${slug}” exists.`,
            "call search_docs with the capability you want to build.",
          );
    },
  );

  server.registerTool(
    "get_example",
    {
      title: "Get a runnable example",
      description:
        "Read one executable Chumbo example with its endpoint, source, tests, and expected behavior.",
      inputSchema: documentInputSchema,
    },
    async ({ slug }) => {
      const document = await getDocument(ctx, "example", slug);
      return document
        ? resourceResult(documentCard(document), documentLink(document))
        : errorResult(
            `No Chumbo example named “${slug}” exists.`,
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
          `No Chumbo pattern named “${pattern}” exists.`,
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
                ? ["", `Pattern: ${selected.title} – ${selected.summary}`]
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
    name: "Chumbo documentation",
    version: "0.11.0",
  },
  resourceUrl,
  auth: { mode: "public", rateLimit: true },
  register,
  resultMiddleware({ result, tool }) {
    if (tool.name !== "search_docs") return;
    const page = result.structuredContent as { next_call?: unknown };
    return {
      append: [
        {
          type: "text",
          text: page.next_call
            ? "Read the most relevant uri with resources/read. Use the exact next call above only if this page does not answer your question; stop when you have enough evidence."
            : "Read the most relevant uri with resources/read, or broaden the query if you need different guidance.",
        },
      ],
    };
  },
});

if (import.meta.main) Deno.serve(app.fetch);
export default app;
