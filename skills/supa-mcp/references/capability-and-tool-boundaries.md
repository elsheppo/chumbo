# Capability and tool boundaries

## Start with an application operation

A useful capability lets an agent accomplish something the application already
means. It should not expose database mechanics merely because Postgres makes
them available.

Describe the operation before naming the tool:

```text
Actor: signed-in directory owner
Intent: submit one of their draft listings for review
Authority: ownership enforced by the caller's RLS session
Outcome: the draft enters the existing review workflow
Useful result: listing ID, resulting status, and what happens next
```

This naturally produces `submit_listing`, not `update_listings_table`.

## Choose the MCP primitive

- **Tool:** a bounded query, computation, or action the model may decide to
  invoke with parameters.
- **Resource:** addressable read-only content, especially a complete or large
  body that can be read independently.
- **Prompt:** a user-invoked workflow starter. Do not use prompts as hidden
  orchestration or implicit mutations.
- **Server instructions:** concise orientation explaining how the capability
  surface hangs together. Generate them from request context when different
  identities receive materially different surfaces.

Do not turn one operation into several protocol primitives without a real
consumer reason. A tool may return a link to a Resource when the operation
finds complete content that should be read separately.

## Design the tool contract

- Name tools with an application verb and object: `search_businesses`,
  `list_my_drafts`, `submit_listing`, `approve_submission`.
- Describe eligibility, effect, and returned outcome. Do not narrate SQL or
  Edge Function implementation.
- Inputs express intent. Never accept `user_id`, `owner_id`, roles, scopes, or
  authorization flags that the verified context already determines.
- Ask only for values the operation genuinely needs. Avoid generic filters,
  arbitrary column names, and unbounded query objects.
- Return durable identifiers needed by likely follow-up operations. Omit
  internal storage and audit columns unless they change the next decision.
- Keep mutations narrow and explicit. A review action should not accept an
  arbitrary status string if the application operation is specifically
  approval.
- Add an obvious next action to a result only when it helps. An agent does not
  need every tool response to advertise another tool.

## Shape the surface coherently

Start with the smallest set that completes the user journey. A coherent
directory surface might contain:

```text
search_businesses
get_business
list_my_drafts
submit_listing
```

Add moderation capabilities only to the identity that can use them. Do not
generate one tool per table or introspect the schema into a generic CRUD bag.

Scopes are capability vocabulary, not application roles. Prefer
`directory:read` and `directory:moderate` over teaching Supa MCP what an
"owner" or "admin" means. The application resolves which verified principals
receive those scopes.

## Review questions

Before implementing, answer:

1. Would the tool name and description make sense without seeing the database?
2. Can the caller influence identity or authority through its inputs?
3. Does this capability reuse the application's established operation, or
   invent a parallel path?
4. Is the result limited to what the next reasoning step needs?
5. Could a Resource, prompt, or instruction express this more accurately than
   a tool?
