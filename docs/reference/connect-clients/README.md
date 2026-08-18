# Connect your MCP client

A deployed Supa MCP endpoint speaks Streamable HTTP at
`https://PROJECT_REF.supabase.co/functions/v1/<function>`. Connect it once
`npx supa-mcp doctor --url <endpoint>` reports the runtime healthy.

**Claude Code**

```sh
claude mcp add --transport http my-app https://PROJECT_REF.supabase.co/functions/v1/mcp
```

OAuth mode: run `/mcp` inside Claude Code to complete the browser sign-in.
API-key or bearer mode: add
`--header "Authorization: Bearer <credential>"` to the same command.
`claude mcp list` shows per-server connection health.

**claude.ai and Claude Desktop** — Settings → Connectors → Add custom
connector, then paste the endpoint URL. Requires OAuth mode with dynamic
client registration enabled, because the connector registers itself as an
OAuth client against the project's Supabase Auth server. API-key and bearer
endpoints are not connectable here; use them from clients that send headers.

**Cursor** — add the server to `.cursor/mcp.json` (project) or
`~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "my-app": {
      "url": "https://PROJECT_REF.supabase.co/functions/v1/mcp",
      "headers": { "Authorization": "Bearer <credential>" }
    }
  }
}
```

Omit `headers` for OAuth mode; Cursor initiates the OAuth flow itself.

**MCP Inspector** — `npx @modelcontextprotocol/inspector`, transport
Streamable HTTP, paste the endpoint. The most direct way to watch requests
and results while developing locally against
`http://127.0.0.1:54321/functions/v1/mcp`.

## Verification status

| Client                        | Transport        | Access modes           | Status                                                                                                          |
| ----------------------------- | ---------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| Claude Code                   | Streamable HTTP  | public, api-key/bearer | Verified: connects to the hosted reference deployment (`claude mcp list` reports connected)                     |
| Raw MCP protocol (any client) | Streamable HTTP  | all                    | Verified: `initialize`, `tools/list`, and `tools/call` exercised by `pnpm reference:check` and the hosted smoke |
| claude.ai / Claude Desktop    | Custom connector | oauth + DCR only       | Vendor-documented; not yet exercised against the reference deployment                                           |
| Cursor                        | Streamable HTTP  | all                    | Vendor-documented; not yet exercised against the reference deployment                                           |
| MCP Inspector                 | Streamable HTTP  | all                    | Vendor-documented; speaks the same verified protocol surface                                                    |

Rows marked vendor-documented follow those clients' published remote-MCP
instructions; promote them to verified by connecting once and recording the
result here.

If a client reports the server unreachable, run
`npx supa-mcp doctor --url <endpoint>` first: it distinguishes a gateway 401
(missing `verify_jwt = false`) from an endpoint that is healthy but waiting
for a credential.

Official platform references:

- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
