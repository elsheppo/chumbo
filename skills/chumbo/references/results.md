# Design results

Choose the smallest result contract that serves a real consumer. Returning the
same value as both text and structured data wastes model context and usually
makes neither representation better.

| Helper                            | Use it for                                                | Wire contract                                                                  |
| --------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `textResult(text)`                | A model or person needs a purpose-written answer          | Text content only                                                              |
| `structuredResult(value)`         | A typed client, UI, or later composition needs exact data | `structuredContent` matching the tool's `outputSchema`                         |
| `renderResult(value, render)`     | Both model-facing and typed consumers genuinely matter    | Purpose-written text plus exact structured data and `outputSchema`             |
| `resourceResult(text, link)`      | Content is complete, large, or independently addressable  | A short reading card and `resource_link`; the body comes from `resources/read` |
| `errorResult(message, nextStep?)` | The operation failed                                      | Error text and a valid recovery step when one exists                           |

## Text for the model

Write the answer the next reasoning step needs. Preserve useful identifiers,
explain empty states, and omit storage details. Do not stringify a database row
and call it model-facing prose.

## Bounded collections

Use `collectionInputSchema`, `collectionResult`, and (when typed output is
needed) `collectionOutputSchema` for new list/search tools. Existing tools keep
their contracts until explicitly migrated. Default input is 20 records, maximum
100; default response budget is 16 KiB of UTF-8 serialized `CallToolResult`,
including content, structured data, continuation and metadata. A host may impose
a smaller limit; configure `maxBytes` accordingly (512 bytes to 1 MiB).

The builder owns a stable unique order, cursor validation, source query and
compact projection. Fetch `limit + 1` rows under the current caller's authority.
Pass that bounded window with `hasMore: false`; the extra row proves more exist.
If the source knows there are rows beyond the supplied window, set `hasMore:
true`. Never pass an unbounded full-table result. The helper selects a prefix;
its cursor always comes from the last returned item, including when bytes limit
the page before count does. Supply `cursorFor` for every candidate row.

```ts
const draftSummary = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: z.literal("draft"),
});
server.registerTool(
  "list_my_drafts",
  {
    description: "Browse the connected owner's drafts in stable ID order.",
    inputSchema: collectionInputSchema({ cursorSchema: z.string().uuid() }),
    outputSchema: collectionOutputSchema(draftSummary),
  },
  async ({ limit, cursor }) => {
    let query = ctx.supabase
      .from("drafts")
      .select("id, name, status")
      .eq("status", "draft")
      .order("id")
      .limit(limit + 1);
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) throw error;
    return collectionResult({
      items: data ?? [],
      limit,
      hasMore: false,
      itemSchema: draftSummary,
      project: ({ id, name, status }) => ({ id, name, status }),
      cursorFor: ({ id }) => id,
      tool: "list_my_drafts",
      arguments: cursor ? { cursor } : {},
      mode: "structured",
      onOversizedItem: ({ id }) =>
        `call get_draft with id ${id} for its details.`,
    });
  },
);
```

Only name a detail tool in recovery guidance when you also implement and
register it with the same caller authority. List summaries help an agent select
an item; `get_draft({id})` supplies that item's richer context, and a Resource
carries a long document or transcript. Select only fields the consumer needs;
never spread a database row into the projection. Schema validation can strip
unknown keys but cannot decide which business facts are useful.

The structured page is `{items, has_more, next_cursor, next_call}`; terminal
pages set both continuation fields to `null`. There is no expensive total count.
`next_call` holds a tool name and exact arguments, with the returned cursor and
limit replacing those keys in the builder's supplied safe filters. Pass every
filter required to preserve the query. Do not pass credentials, context objects
or internal options. Text mode (the default) requires a purpose-written
`render(page)` and includes equivalent continuation instructions without
structured output. Hybrid requires that renderer plus a real typed consumer.
Register `outputSchema` only for structured/hybrid modes.

If even one item or the continuation envelope cannot fit, the helper returns
`isError` with no items and no advancing cursor. Use `onOversizedItem` for a
bounded, real detail/Resource next step. The helper never silently skips the
item. Reading a detail alone does not advance the collection: retrying the same
cursor still reaches the oversized item. After the detail is read, a builder
may supply an exact next call using that item's cursor in `onOversizedItem`, or
require a smaller projection. Never describe a failed page as complete. Large
recovery prose falls back to a compact builder-action error.

Queries are live by default. Stable keyset ordering avoids offset drift when
rows before the cursor are deleted, but updates to sort keys and concurrent
inserts can change what later pages contain. For snapshot semantics, the builder
must bind a snapshot/version and filters into its cursor and reauthorize each
read. A cursor is a position, never authority; reapply grants, RLS and application
policy on every page and on detail/Resource reads. Validate malformed/expired
application cursors and return a useful restart instruction where appropriate.

If callers need sorting, extend the input with an application enum such as
`sort: z.enum(["newest", "oldest"]).default("newest")`. Apply it to the source
query, use a stable unique tie-breaker (for example `created_at, id`), and encode
both keys plus query/sort identity in a validated cursor. Pass `sort` and all
other filters in `arguments` so `next_call` preserves them. Reject a cursor
reused with different sort/filters, or require callers to omit the cursor and
restart. Never sort each fetched page independently or infer supported columns
from a table. Chumbo supplies no generic database sorter.

Result middleware may read explicit page metadata and teach an agent when to
continue or stop. It cannot query the next page or infer filters. Chumbo checks
cumulative additive middleware against collection budgets; an addition that
cannot fit is rejected and reported through `onError`, preserving the complete
original page and its continuation. Avoid adding raw JSON copies as guidance.

## Record details and mutation receipts

Use application-shaped records, not table dumps. A detail contract might be
`{id, title, status, summary, transcript_uri}`. Include facts needed to inspect
or decide about that record; long bodies belong behind an authorized Resource.

A mutation receipt might be `{id, outcome: "updated", status, revision}`.
Report the resulting state and a useful next action, without echoing every
submitted argument or returning the whole updated row. If work was merely
queued, report `outcome: "queued"` plus its real status/detail path; do not claim
completion. Use `structuredResult` with a matching `outputSchema` for a typed
consumer, or `textResult` for a concise human-readable receipt. These shapes
are design conventions, not mandatory Chumbo envelopes.

## Intentional hybrid

Hybrid text should interpret or compress the structure, not serialize it
again. Use it only when both consumers are real.

## Resources and reading cards

An MCP Resource is addressable read-only content retrieved through
`resources/read`. `resourceResult` returns a short explanation and a link to
that content; it should not embed the complete body as a fallback.

## Empty and failed outcomes

- No matches, missing records, insufficient authority, conflicts, and
  operational failures are different outcomes with different next steps.
- An empty successful collection is normally a normal result, not an MCP
  error.
- Recommend recovery only when the cause makes that recovery valid.
- Expose an identifier only when the caller can legitimately use it in the
  application.

## Verification

Exercise empty and multi-page results through MCP. Follow the returned exact
next call until terminal, check no duplicate or skipped IDs in a static dataset,
force a byte-limited page and a single oversized record, reject invalid cursors,
and change/revoke authority between pages. Check UTF-8 bytes of the whole result,
including middleware, and prove private source fields never enter either lane.
