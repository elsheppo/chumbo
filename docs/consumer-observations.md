# Consumer observations

These are behaviors observed while using Supa MCP through real MCP clients.
They are product evidence, not promises about every client implementation.

## Large results can be charged twice in model context

Observed in Codex: a result containing a large Markdown document in
`content[].text` and the same document in `structuredContent` can expose both
representations to the model. Nothing is corrupted, but the duplicated payload
creates avoidable response bloat.

Supa MCP continues to support both result channels because other clients,
including Claude integrations observed during development, may ignore
`structuredContent`. The living docs MCP therefore returns a compact portable
reading card by default while preserving the complete document in
`structuredContent`. Portable-only clients can explicitly request `detail:
"full"`.

The general rule remains: keep `content[].text` useful on its own, but do not
repeat a large machine-readable payload there unless the caller needs the
portable full-text fallback.
