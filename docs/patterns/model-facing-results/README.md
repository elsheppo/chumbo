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

Design the contract around the application operation and next reasoning step,
not the shape of the database row that produced it.

The living examples prove purposeful text, typed output, an intentional hybrid,
large-resource delivery, a cause-specific empty state, and a recoverable error.

Source:

- `src/results.ts`
- `supabase/functions/model-facing-results/`
- `supabase/tests/reference_integration_test.ts`
