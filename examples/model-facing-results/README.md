# Capability and result showcase

The executable implementation lives in
`supabase/functions/model-facing-results/`. Its integration test discovers and
invokes tools, reads a Resource, renders a prompt, completes elicitation, and
asserts the actual text an MCP client presents to the model. The
`list_examples` call proves that successful-result middleware can add an
optional follow-up while preserving the handler's structured result.

Run the complete reference check with `pnpm reference:check`.
