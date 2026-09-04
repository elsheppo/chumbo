# Capability and result showcase

The executable implementation lives in
`supabase/functions/model-facing-results/`. Its integration test discovers and
invokes tools, reads a Resource, renders a prompt, completes elicitation, and
asserts the actual text an MCP client presents to the model. The
`list_examples` call proves that successful-result middleware can add an
optional follow-up while preserving the handler's structured result.

Run the complete reference check with `pnpm reference:check`.

## Browse compact collection pages

`list_examples` now defaults to one compact item per page. Its explicit
`next_call` preserves the page size and resumes after the last returned ID.
Execute that exact call to reach the second, terminal page. Middleware teaches
when to continue, when to stop, and how to open full guidance with
`open_result_guide`. No full source record is included in either response lane.

`collectionResult` bounds the whole result, including middleware text, by count
and encoded bytes. Purpose-written text and typed data describe the same page.
The docs MCP also uses these helpers: `search_docs` selects compact summaries
in stable slug order, preserves its search query/kind in continuation, and
returns URIs for authorized `resources/read` detail retrieval.
