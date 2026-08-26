import {
  createSupabaseMcp,
  errorResult,
  renderResult,
  structuredResult,
  type SupabaseMcpContext,
  type SupabaseMcpServer,
} from "chumbo";
import { z } from "zod";

const APP_URI = "ui://supa-mcp/review-queue.html";
const APP_MIME_TYPE = "text/html;profile=mcp-app";

const reviewItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  summary: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});

const queueSchema = z.object({
  items: z.array(reviewItemSchema),
  pendingCount: z.number().int().nonnegative(),
});

interface ReviewItemRow {
  id: string;
  owner_id: string;
  title: string;
  summary: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  decided_at: string | null;
}

interface ReferenceDatabase {
  public: {
    Tables: {
      review_items: {
        Row: ReviewItemRow;
        Insert: Omit<ReviewItemRow, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<ReviewItemRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

type ReviewItem = z.infer<typeof reviewItemSchema>;
type Queue = z.infer<typeof queueSchema>;

function toReviewItem(row: ReviewItemRow): ReviewItem {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    status: row.status,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

async function readQueue(ctx: SupabaseMcpContext<any>): Promise<Queue> {
  const { data, error } = await ctx.supabase
    .from("review_items")
    .select("id, owner_id, title, summary, status, created_at, decided_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  const items = ((data ?? []) as ReviewItemRow[]).map(toReviewItem);
  return {
    items,
    pendingCount: items.filter((item) => item.status === "pending").length,
  };
}

function queueText(queue: Queue): string {
  if (queue.items.length === 0) {
    return "## Review queue\n\nYour queue is empty.\n\n→ Next: add an application item that needs review.";
  }
  const pending = queue.items.filter((item) => item.status === "pending");
  if (pending.length === 0) {
    return `## Review queue\n\nAll ${queue.items.length} items have been decided. Open the interactive queue to inspect the completed decisions.\n\n→ Next: add another item when something needs review.`;
  }
  const rows = pending
    .slice(0, 5)
    .map((item) => `- **${item.title}** – ${item.summary}`)
    .join("\n");
  return `## Review queue\n\n${queue.pendingCount} pending item${
    queue.pendingCount === 1 ? "" : "s"
  }.\n\n${rows}\n\n→ Next: open the interactive queue to approve or reject an item.`;
}

async function reviewQueueHtml(): Promise<string> {
  return await Deno.readTextFile(
    new URL("./dist/review-queue.html", import.meta.url),
  );
}

function appMeta(visibility: readonly ("model" | "app")[]) {
  return {
    ui: { resourceUri: APP_URI, visibility },
    "ui/resourceUri": APP_URI,
  };
}

function register(server: SupabaseMcpServer, ctx: SupabaseMcpContext<any>) {
  server.withScopes(["review:read"]).registerTool(
    "open_review_queue",
    {
      title: "Open review queue",
      description:
        "Open the signed-in user's interactive review queue. Use when the user wants to inspect, approve, or reject pending items visually.",
      inputSchema: z.object({}),
      outputSchema: queueSchema,
      annotations: { readOnlyHint: true },
      _meta: appMeta(["model"]),
    },
    async () => {
      const queue = await readQueue(ctx);
      return renderResult(queue, queueText);
    },
  );

  server.withScopes(["review:read"]).registerTool(
    "refresh_review_queue",
    {
      title: "Refresh review queue",
      description: "Refresh the current user's interactive review queue.",
      inputSchema: z.object({}),
      outputSchema: queueSchema,
      annotations: { readOnlyHint: true },
      _meta: appMeta(["app"]),
    },
    async () => structuredResult(await readQueue(ctx)),
  );

  server.withScopes(["review:decide"]).registerTool(
    "decide_review_item",
    {
      title: "Decide review item",
      description:
        "Approve or reject one pending item in the current user's review queue.",
      inputSchema: z.object({
        id: z.string().uuid(),
        decision: z.enum(["approved", "rejected"]),
      }),
      outputSchema: queueSchema,
      annotations: { destructiveHint: true, idempotentHint: true },
      _meta: appMeta(["app"]),
    },
    async ({ id, decision }) => {
      const { data, error } = await ctx.supabase
        .from("review_items")
        .update({ status: decision, decided_at: new Date().toISOString() })
        .eq("id", id)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        return errorResult(
          "That pending review item was not found for this user.",
          "refresh the queue before trying another decision",
        );
      }
      return structuredResult(await readQueue(ctx));
    },
  );

  server.withScopes(["review:read"]).registerResource(
    "review-queue-app",
    APP_URI,
    {
      title: "Review queue app",
      description: "Interactive queue for reviewing application-owned items.",
      mimeType: APP_MIME_TYPE,
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: APP_MIME_TYPE,
          text: await reviewQueueHtml(),
          _meta: {
            ui: {
              csp: {},
              prefersBorder: true,
            },
          },
        },
      ],
    }),
  );
}

const projectUrl = Deno.env.get("SUPABASE_URL");
if (!projectUrl) throw new Error("SUPABASE_URL is not configured");

const resourceUrl = new URL(
  Deno.env.get("REVIEW_QUEUE_APP_PUBLIC_URL") ??
    `${projectUrl}/functions/v1/review-queue-app`,
);

const app = createSupabaseMcp<ReferenceDatabase>({
  server: { name: "Chumbo review queue app", version: "0.1.0" },
  instructions:
    "Use open_review_queue when a user wants to inspect or decide application items visually. The interactive app owns UI mechanics; durable decisions remain server-authorized.",
  resourceUrl,
  auth: { mode: "oauth", strategy: "supabase-user" },
  access: {
    resolveScopes: () => ["review:read", "review:decide"],
  },
  register,
});

const allowedBrowserOrigins = new Set([
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "https://claude.ai",
]);

function browserCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin || !allowedBrowserOrigins.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers":
      "accept, authorization, content-type, last-event-id, mcp-method, mcp-name, mcp-protocol-version, mcp-session-id",
    "access-control-expose-headers":
      "mcp-session-id, www-authenticate, x-supa-mcp-version, x-supa-mcp-auth-mode, x-supa-mcp-auth-strategy, x-supa-mcp-resource-url",
    vary: "origin",
  };
}

async function fetchReviewQueueApp(request: Request): Promise<Response> {
  const cors = browserCorsHeaders(request);
  if (request.method === "OPTIONS" && cors["access-control-allow-origin"]) {
    return new Response(null, {
      status: 204,
      headers: { ...cors, "access-control-max-age": "86400" },
    });
  }
  const response = await app.fetch(request);
  if (!cors["access-control-allow-origin"]) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(cors)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

if (import.meta.main) Deno.serve(fetchReviewQueueApp);
export default app;
