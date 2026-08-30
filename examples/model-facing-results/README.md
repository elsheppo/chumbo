# Capability and result showcase

The executable implementation lives in
`supabase/functions/model-facing-results/`. Its integration test discovers and
invokes tools, reads a Resource, renders a prompt, completes elicitation, and
asserts the actual text an MCP client presents to the model.

Run the complete reference check with `pnpm reference:check`.
