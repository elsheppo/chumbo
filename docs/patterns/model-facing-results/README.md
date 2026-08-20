# Model-facing tool results

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
