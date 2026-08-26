import {
  createSupabaseMcp,
  errorResult,
  renderResult,
  SupabaseMcpStateConflictError,
  type SupabaseMcpContext,
  type SupabaseMcpServer,
  type SupabaseMcpState,
  type SupabaseMcpStateValue,
} from "chumbo";
import { z } from "zod";

const OBSERVATION_NAMESPACE = "reference.observations";

type ObservationReceipt = {
  resourceVersion: number;
  scope: "full-document";
  observedAt: string;
};

type GuardedDocument = {
  id: string;
  title: string;
  content: string;
  version: number;
};

type MutationRow = GuardedDocument & {
  status: "written" | "missing" | "stale" | "text_missing" | "text_not_unique";
};

const projectUrl = Deno.env.get("SUPABASE_URL");
const stateHmacKey = Deno.env.get("SUPA_MCP_STATE_HMAC_KEY");
if (!projectUrl) throw new Error("SUPABASE_URL is not configured");
if (!stateHmacKey) {
  throw new Error("SUPA_MCP_STATE_HMAC_KEY is not configured");
}

const resourceUrl = new URL(
  Deno.env.get("OBSERVATION_BEFORE_ACTION_PUBLIC_URL") ??
    `${projectUrl}/functions/v1/observation-before-action`,
);

function receiptKey(documentId: string): string {
  return `document:${documentId}`;
}

function firstRow<Value>(data: Value | Value[] | null): Value | undefined {
  return Array.isArray(data) ? data[0] : (data ?? undefined);
}

function validReceipt(value: unknown): value is ObservationReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<ObservationReceipt>;
  return (
    Number.isSafeInteger(receipt.resourceVersion) &&
    (receipt.resourceVersion ?? 0) > 0 &&
    receipt.scope === "full-document" &&
    typeof receipt.observedAt === "string" &&
    Number.isFinite(Date.parse(receipt.observedAt))
  );
}

async function recordObservation(
  state: SupabaseMcpState,
  key: string,
  value: ObservationReceipt,
): Promise<SupabaseMcpStateValue<ObservationReceipt>> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await state.get<ObservationReceipt>(
      OBSERVATION_NAMESPACE,
      key,
    );
    try {
      return await state.put(OBSERVATION_NAMESPACE, key, {
        value,
        expectedRevision: current?.revision ?? null,
      });
    } catch (error) {
      if (error instanceof SupabaseMcpStateConflictError) continue;
      throw error;
    }
  }
  throw new SupabaseMcpStateConflictError();
}

function register(server: SupabaseMcpServer, ctx: SupabaseMcpContext<any>) {
  server.registerTool(
    "read_document",
    {
      title: "Read a guarded document",
      description:
        "Read one document and record the current version for this exact authenticated credential. Call this before edit_document.",
      inputSchema: z.object({ document_id: z.string().uuid() }),
      outputSchema: z.object({
        document: z.object({
          id: z.string().uuid(),
          title: z.string(),
          content: z.string(),
          version: z.number().int().positive(),
        }),
      }),
    },
    async ({ document_id }) => {
      if (!ctx.state) {
        return errorResult(
          "Durable observation state is unavailable.",
          "retry the read before attempting an edit.",
        );
      }
      const { data, error } = await ctx.supabase
        .from("demo_guarded_documents")
        .select("id, title, content, version")
        .eq("id", document_id)
        .single();
      if (error || !data) {
        return errorResult(
          "The document is unavailable to this caller.",
          "choose an RLS-visible document and read it first.",
        );
      }
      const document = data as GuardedDocument;
      try {
        await recordObservation(ctx.state, receiptKey(document.id), {
          resourceVersion: document.version,
          scope: "full-document",
          observedAt: new Date().toISOString(),
        });
      } catch {
        return errorResult(
          "The document was read, but its observation receipt could not be recorded.",
          "retry read_document; editing remains blocked until it succeeds.",
        );
      }
      return renderResult({ document }, ({ document }) =>
        [
          `# ${document.title}`,
          "",
          document.content,
          "",
          `Version: ${document.version}`,
          "",
          "This exact credential may now call edit_document while this version remains current.",
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "edit_document",
    {
      title: "Edit an observed document",
      description:
        "Replace one unique exact string. The call is denied unless this credential previously read the document version that is still current.",
      inputSchema: z.object({
        document_id: z.string().uuid(),
        old_text: z.string().min(1).max(8_000),
        new_text: z.string().max(8_000),
      }),
      outputSchema: z.object({
        document: z.object({
          id: z.string().uuid(),
          title: z.string(),
          content: z.string(),
          version: z.number().int().positive(),
        }),
        receiptAdvanced: z.boolean(),
      }),
    },
    async ({ document_id, old_text, new_text }) => {
      if (!ctx.state) {
        return errorResult(
          "Durable observation state is unavailable; the edit was not attempted.",
          "retry after state is available, then read the document again.",
        );
      }
      let observed: SupabaseMcpStateValue<ObservationReceipt> | null;
      try {
        observed = await ctx.state.get<ObservationReceipt>(
          OBSERVATION_NAMESPACE,
          receiptKey(document_id),
        );
      } catch {
        return errorResult(
          "The observation receipt could not be checked; the edit was not attempted.",
          "retry after state is available, then read the document again.",
        );
      }
      if (!observed || !validReceipt(observed.value)) {
        return errorResult(
          "This credential has not observed the document.",
          "call read_document first, then retry the edit.",
        );
      }

      const { data, error } = await ctx.supabase.rpc(
        "edit_demo_guarded_document",
        {
          p_document_id: document_id,
          p_expected_version: observed.value.resourceVersion,
          p_old_text: old_text,
          p_new_text: new_text,
        },
      );
      if (error) {
        return errorResult(
          "The authoritative document mutation failed; the receipt was not advanced.",
          "retry safely or reread the document.",
        );
      }
      const mutation = firstRow(data as MutationRow | MutationRow[] | null);
      if (!mutation || mutation.status !== "written") {
        const nextStep =
          mutation?.status === "stale"
            ? "call read_document to observe the current version, then retry."
            : mutation?.status === "text_not_unique"
              ? "reread and provide enough exact surrounding text to identify one occurrence."
              : mutation?.status === "text_missing"
                ? "reread and copy exact text from the current document."
                : "confirm the document is still visible, then read it again.";
        return errorResult("The guarded edit was rejected.", nextStep);
      }

      const document: GuardedDocument = {
        id: mutation.id,
        title: mutation.title,
        content: mutation.content,
        version: mutation.version,
      };
      let receiptAdvanced = false;
      try {
        await ctx.state.put(OBSERVATION_NAMESPACE, receiptKey(document.id), {
          value: {
            resourceVersion: document.version,
            scope: "full-document",
            observedAt: new Date().toISOString(),
          },
          expectedRevision: observed.revision,
        });
        receiptAdvanced = true;
      } catch {
        // The domain mutation already committed. A missing or conflicting
        // receipt is a safe false negative: require a reread, never imply that
        // the document write failed or advance state before the write.
      }

      return renderResult(
        { document, receiptAdvanced },
        ({ document, receiptAdvanced }) =>
          [
            `Edited **${document.title}** at version ${document.version}.`,
            "",
            receiptAdvanced
              ? "The observation receipt advanced; another guarded edit may follow."
              : "The document changed, but the receipt did not advance. Reread before another edit.",
          ].join("\n"),
      );
    },
  );
}

const app = createSupabaseMcp({
  server: { name: "Observation before action", version: "0.8.0" },
  resourceUrl,
  auth: { mode: "bearer" },
  state: {
    hmacKey: stateHmacKey,
    namespaces: {
      [OBSERVATION_NAMESPACE]: { ttlSeconds: 86_400 },
    },
  },
  register,
});

if (import.meta.main) Deno.serve(app.fetch);
export default app;
