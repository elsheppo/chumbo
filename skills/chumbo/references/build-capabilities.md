# Build capabilities

A useful capability expresses something the application already means. Start
with the actor and outcome before choosing a protocol primitive or tool name.

```text
Actor: signed-in directory owner
Intent: submit one of their draft listings for review
Authority: ownership enforced by the caller's RLS session
Outcome: the draft enters the existing review workflow
Useful result: listing ID, resulting status, and what happens next
```

That produces `submit_listing`, not `update_listings_table`.

## Choose the MCP primitive

| Primitive           | Use it for                                                             |
| ------------------- | ---------------------------------------------------------------------- |
| Tool                | A bounded query, computation, or action the model may decide to invoke |
| Resource            | Addressable read-only content, especially a complete or large body     |
| Prompt              | A user-invoked workflow starter, not hidden orchestration or mutation  |
| Server instructions | Concise orientation for using the available capabilities               |

A tool may return a link to a Resource when it finds complete content that
should be read separately. Do not register the same operation through several
primitives without a real consumer reason.

## Design a tool contract

- Name the application verb and object: `search_businesses`, `list_my_drafts`,
  `submit_listing`, `approve_submission`.
- Describe who can use it, what it does, and what the result means. Hide SQL and
  Edge Function implementation details.
- Ask only for values the operation genuinely needs. Avoid arbitrary column
  names, generic filters, and unbounded update objects.
- Return durable identifiers needed for likely follow-up operations. Omit
  internal storage and audit columns unless they change the next decision.
- Keep mutations narrow. `approve_submission` should not accept an arbitrary
  status value when approval is the actual operation.

A user or resource ID can be a valid domain argument. It must not substitute
for the verified caller's identity or grant authority merely because the model
supplied it.

## Build a coherent surface

Start with the smallest set that completes a user journey:

```text
search_businesses
get_business
list_my_drafts
submit_listing
```

Add privileged operations only when a real identity can use them. Avoid one
tool per table and schema-generated CRUD bags.

Before implementation, answer:

1. Would the name and description make sense without seeing the database?
2. Does the operation reuse established application behavior?
3. Can any input improperly select caller identity or authority?
4. Does the result contain only what the next reasoning step needs?
5. Is a tool, Resource, prompt, or instruction the clearest primitive?
