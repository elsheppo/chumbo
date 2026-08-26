# Guarded document editing example

The living function at `supabase/functions/observation-before-action/` exposes
two tools:

- `read_document` returns one RLS-visible document and records its immutable ID,
  current resource version, full-document scope, and observation time.
- `edit_document` refuses a caller with no receipt, passes the observed resource
  version into an atomic database function, and advances the receipt only after
  the document mutation succeeds.

The example intentionally creates receipts only after resolving a real,
authorized document. It never uses arbitrary caller text as the durable-state
key. The reference test covers blind-write denial, stale-write rejection, and
concurrent one-winner behavior.

Run the complete evidence path with `pnpm reference:check`.
