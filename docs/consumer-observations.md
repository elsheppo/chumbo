# Consumer observations

These are behaviors observed while using Supa MCP through real MCP clients.
They are product evidence, not promises about every client implementation.

## Large results can be charged twice in model context

Observed in Codex: a result containing a large Markdown document in
`content[].text` and the same document in `structuredContent` can expose both
representations to the model. Nothing is corrupted, but the duplicated payload
creates avoidable response bloat.

Supa MCP does not mechanically duplicate result channels. Builders use
purpose-written text, exact structured data, or an intentional hybrid according
to the real consumer. Large documents belong in MCP Resources: the living docs
MCP returns a compact reading card and `resource_link`, while `resources/read`
serves the complete Markdown only when requested.

The general rule remains: keep `content[].text` useful on its own, but do not
repeat a large machine-readable payload there. Use a Resource when the body is
too large for a normal tool result.
