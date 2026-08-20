# Production contrasts

Use these contrasts to review the design, not as names or schemas every
application must copy.

## Database access versus application operation

Weak:

```text
update_table(table, id, values)
```

Strong:

```text
submit_listing(listing_id)
```

The strong tool expresses a bounded product transition, can validate the real
preconditions, and returns the resulting application state.

## Caller-supplied authority versus request identity

Weak:

```ts
inputSchema: z.object({ ownerId: z.string(), listingId: z.string() });
```

Strong:

```ts
inputSchema: z.object({ listingId: z.string().uuid() });
// Query with ctx.supabase; the caller's RLS session determines ownership.
```

Identity and ownership are facts established by authentication and the data
plane, not choices the model makes.

## Duplicated serialization versus a deliberate result

Weak:

```text
content[0].text = JSON.stringify(rows)
structuredContent = rows
```

Strong choices:

- purpose-written text when the model is the consumer;
- an exact structured contract when a typed client needs it;
- a short interpretation plus structure only when both matter;
- a reading card and Resource link for a complete body.

Do not select a hybrid merely to hedge against every possible client.

## Advertised privilege versus capability filtering

Weak:

```text
Everyone discovers approve_submission; the handler checks isAdmin.
```

Strong:

```ts
server
  .withScopes(["directory:moderate"])
  .registerTool("approve_submission", options, handler);
```

Then keep the existing moderation RPC or API authoritative for the mutation.
The capability surface and data plane agree without making Supa MCP define an
administrator role.

## Fictional API-key users versus application principals

Weak:

```text
Turn a directory API key into a made-up Supabase user, or use service role in
every handler so RLS stops getting in the way.
```

Strong:

```text
Verify the key into a stable application subject and explicit scopes. Use the
application's existing narrow verifier-aware RPC or API for privileged work.
Keep the verifier-only admin client out of handlers.
```

## Completion theater versus boundary evidence

Weak:

```text
The capability compiles and its handler unit test passes.
```

Strong:

```text
Two callers produce the intended discovery surfaces through tools/list; valid
calls produce the application outcome; hidden direct calls, wrong credentials,
and cross-user row access fail through the real transport.
```
