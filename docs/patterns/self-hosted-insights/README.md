# Self-hosted Insights

Use `chumbo/insights` and `chumbo setup --insights` when your team wants
payload-free capability usage, alphabetical member activity, and plain-word run
timelines stored inside your own Supabase project.

## Quick start

```sh
npx chumbo setup --insights --apply-migrations
supabase secrets set CHUMBO_RUN_HMAC_KEY="replace-with-at-least-32-random-bytes"
```

Open the generated `insights/index.html` and sign in with Supabase Auth:

1. **Your runs** work out of the box for your own signed-in user (`auth.uid()::text = p_member`).
2. **Workspace totals & People** stay fail-closed until you replace `chumbo_telemetry.insights_is_admin(uid uuid)` with your organization admin check (using `raw_app_meta_data`, never user-editable `raw_user_meta_data`).
3. **Composable sinks:** Running `npx chumbo cloud setup` wraps an existing `onEvent` sink with `composeEventSinks(existingSink, chumboCloudOnEvent)` so self-hosted telemetry and pseudonymous Cloud aggregates run side by side.
