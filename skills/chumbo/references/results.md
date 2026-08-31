# Design results

Choose the smallest result contract that serves a real consumer. Returning the
same value as both text and structured data wastes model context and usually
makes neither representation better.

| Helper                            | Use it for                                                | Wire contract                                                                  |
| --------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `textResult(text)`                | A model or person needs a purpose-written answer          | Text content only                                                              |
| `structuredResult(value)`         | A typed client, UI, or later composition needs exact data | `structuredContent` matching the tool's `outputSchema`                         |
| `renderResult(value, render)`     | Both model-facing and typed consumers genuinely matter    | Purpose-written text plus exact structured data and `outputSchema`             |
| `resourceResult(text, link)`      | Content is complete, large, or independently addressable  | A short reading card and `resource_link`; the body comes from `resources/read` |
| `errorResult(message, nextStep?)` | The operation failed                                      | Error text and a valid recovery step when one exists                           |

## Text for the model

Write the answer the next reasoning step needs. Preserve useful identifiers,
explain empty states, and omit storage details. Do not stringify a database row
and call it model-facing prose.

## Structured output

The schema belongs to the application contract, not the table layout:

```ts
outputSchema: z.object({
  drafts: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      status: z.literal("draft"),
    }),
  ),
});
```

Return exactly that shape. Omit ownership IDs, token hashes, storage keys, and
internal audit fields unless a real consumer needs them.

## Intentional hybrid

Hybrid text should interpret or compress the structure, not serialize it
again. Use it only when both consumers are real.

## Resources and reading cards

An MCP Resource is addressable read-only content retrieved through
`resources/read`. `resourceResult` returns a short explanation and a link to
that content; it should not embed the complete body as a fallback.

## Empty and failed outcomes

- No matches, missing records, insufficient authority, conflicts, and
  operational failures are different outcomes with different next steps.
- An empty successful collection is normally a normal result, not an MCP
  error.
- Recommend recovery only when the cause makes that recovery valid.
- Expose an identifier only when the caller can legitimately use it in the
  application.
