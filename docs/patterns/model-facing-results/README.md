# Capability and result showcase

Keep the generated Chumbo starter small, then use this executable living
pattern when you need the wider official MCP surface. The same function proves:

- tool discovery and invocation;
- a linked and readable MCP Resource;
- prompt discovery and rendering;
- an elicitation request and accepted continuation;
- text, structured, hybrid, Resource-linked, empty, and recoverable-error
  results.

The implementation remains ordinary MCP registration code. Chumbo does not
introduce a second capability framework.

## Choose the result for its consumer

Choose the smallest result contract that serves a real consumer:

- `textResult(text)` for an agent-facing answer.
- `structuredResult(value)` plus `outputSchema` for typed composition.
- `renderResult(value, render)` only when both representations matter.
- `resourceResult(text, link)` for large content served by MCP Resources.
- `errorResult(message, nextStep)` for recoverable failures.
- `appendResultText(result, text)` or `prependResultText(result, text)` for
  bounded guidance that preserves an authored successful result.

Design the contract around the application operation and next reasoning step,
not the shape of the database row that produced it.

The living examples prove purposeful text, typed output, an intentional hybrid,
large-resource delivery, a cause-specific empty state, and a recoverable error.
The `list_examples` result also proves server-wide `resultMiddleware`: its
handler authors the hybrid result, then middleware adds one optional follow-up
without replacing the content, structured data, or metadata.

Guidance added by a helper or middleware remains ordinary model-facing result
content. It can explain an available follow-up, but it cannot require the
client to perform one.

Source:

- `src/results.ts`
- `supabase/functions/model-facing-results/`
- `supabase/tests/reference_integration_test.ts`

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
