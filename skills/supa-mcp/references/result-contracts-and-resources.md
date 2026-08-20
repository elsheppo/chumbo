# Result contracts and Resources

Choose the smallest result contract that serves a real consumer. MCP permits
model-facing text and typed structured data, but returning both automatically
duplicates large results and often makes the model's useful channel worse.

| Helper                            | Use when                                                       | Contract                                                               |
| --------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `textResult(text)`                | The model or person is the meaningful consumer                 | Purpose-written text only                                              |
| `structuredResult(value)`         | A typed client, UI, or later tool composition needs exact data | Exact JSON-compatible `structuredContent`; define `outputSchema`       |
| `renderResult(value, render)`     | Both model-facing and typed consumers genuinely matter         | Purpose-written text plus exact structured data; define `outputSchema` |
| `resourceResult(text, link)`      | Content is complete, large, or independently addressable       | Concise text and `resource_link`; full body only in `resources/read`   |
| `errorResult(message, nextStep?)` | The operation failed                                           | MCP error text with a cause-appropriate recovery step when one exists  |

## Structured-only result

The structured contract belongs to the application, not its storage layout:

```ts
server.registerTool(
  "list_my_drafts",
  {
    description: "List the connected owner's draft listings.",
    inputSchema: z.object({}),
    outputSchema: z.object({
      drafts: z.array(
        z.object({
          id: z.string().uuid(),
          name: z.string(),
          status: z.literal("draft"),
        }),
      ),
    }),
  },
  async () => structuredResult({ drafts }),
);
```

Do not return an unfiltered row with ownership IDs, internal timestamps, token
hashes, or storage keys simply because the query produced them.

## Intentional hybrid

Hybrid text interprets or compresses the data. It does not stringify the same
object:

```ts
return renderResult({ drafts }, ({ drafts }) =>
  drafts.length === 0
    ? "You have no draft listings."
    : `You have ${drafts.length} drafts. The oldest is ${drafts[0].name}.`,
);
```

Use a hybrid only when a concrete typed consumer exists. Model compatibility
alone is not a reason to manufacture structured output.

## Large or complete content

Register the full content as a Resource and return only a reading card:

```ts
server.registerResource(
  "editorial-guide",
  "supa-mcp://directory/editorial-guide",
  {
    title: "Directory editorial guide",
    mimeType: "text/markdown",
    cacheHint: { cacheScope: "private", ttlMs: 60_000 },
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: guide }],
  }),
);

return resourceResult("Open the editorial guide before reviewing.", {
  type: "resource_link",
  name: "editorial-guide",
  uri: "supa-mcp://directory/editorial-guide",
  title: "Directory editorial guide",
  mimeType: "text/markdown",
});
```

Use private cache hints for caller-specific or access-controlled Resources.
Public immutable documentation may use public hints. Never embed the complete
body in the tool result as a fallback; clients read it with `resources/read`.

## Collections, empty states, and failures

- Paginate collections before they become large. Return the cursor and stable
  identifiers the next call needs.
- Distinguish no matches, missing records, lack of authority, conflicts, and
  operational failures. They imply different next steps.
- An empty successful query is normally a normal result, not an MCP error.
- Use `errorResult` for an actual failed operation. Recommend recovery only
  when the cause makes that recovery valid.
- Test the exact wire shape. In particular, prove structured-only results have
  no manufactured text and Resource results do not embed the body.
