# Model-facing tool results

Use `renderResult(value, render)` when the model needs data plus interpretation,
empty-state meaning, or a next action. The renderer's text must stand alone;
some MCP clients do not surface `structuredContent` to the model.

Use `jsonResult(value)` as a legible prototyping fallback. It renders Markdown
instead of dumping JSON. Use `errorResult(message, nextStep)` for failures that
the model can recover from.

The living example proves three surfaces: a populated result, a cause-specific
empty state, and a recoverable error. Its tests inspect the actual
`content[0].text` rather than treating `structuredContent` as model evidence.

Source:

- `src/results.ts`
- `supabase/functions/model-facing-results/`
- `supabase/tests/reference_integration_test.ts`
