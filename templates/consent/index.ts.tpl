const projectUrl = Deno.env.get("SUPABASE_URL");
const publishableKeys = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
const publishableKey = publishableKeys
  ? (JSON.parse(publishableKeys) as Record<string, string>).default
  : (Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
    Deno.env.get("SUPABASE_ANON_KEY"));

if (!projectUrl || !publishableKey) {
  throw new Error("SUPABASE_URL and a Supabase publishable key are required");
}

const html = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Connect to {{SERVER_NAME}}</title>
    <style>
      :root { color-scheme: light dark; font: 16px/1.45 system-ui, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0d10; color: #f5f7fa; }
      main { width: min(30rem, calc(100vw - 3rem)); padding: 2rem; border: 1px solid #2b3038; border-radius: 1rem; background: #15191f; }
      form, #consent { display: grid; gap: 1rem; }
      input, button { box-sizing: border-box; width: 100%; padding: .8rem; border-radius: .55rem; border: 1px solid #3a414c; font: inherit; }
      button { cursor: pointer; background: #3ecf8e; color: #07130e; border: 0; font-weight: 700; }
      button.secondary { background: transparent; color: inherit; border: 1px solid #555f6d; }
      .actions { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }
      #status { min-height: 1.5rem; color: #ffbd73; }
    </style>
  </head>
  <body>
    <main>
      <h1>Connect to {{SERVER_NAME}}</h1>
      <p id="status">Loading authorization request…</p>
      <form id="login" hidden>
        <p>Sign in with your existing application account to continue.</p>
        <input id="email" type="email" autocomplete="email" placeholder="Email" required />
        <input id="password" type="password" autocomplete="current-password" placeholder="Password" required />
        <button>Sign in</button>
      </form>
      <section id="consent" hidden>
        <p><strong id="client"></strong> wants to connect to your account.</p>
        <p id="scopes"></p>
        <div class="actions">
          <button id="deny" class="secondary">Deny</button>
          <button id="approve">Approve</button>
        </div>
      </section>
    </main>
    <script type="module">
      import { createClient } from "https://esm.sh/@supabase/supabase-js@2.105.4";

      const supabase = createClient(${JSON.stringify(projectUrl)}, ${JSON.stringify(publishableKey)});
      const authorizationId = new URL(location.href).searchParams.get("authorization_id");
      const status = document.querySelector("#status");
      const login = document.querySelector("#login");
      const consent = document.querySelector("#consent");

      if (!authorizationId) {
        status.textContent = "Missing authorization_id.";
        throw new Error("Missing authorization_id");
      }

      async function showAuthorization() {
        const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
        if (error) throw error;
        if ("redirect_url" in data) {
          location.assign(data.redirect_url);
          return;
        }
        document.querySelector("#client").textContent = data.client.name ?? "An MCP client";
        document.querySelector("#scopes").textContent = data.scope
          ? "Requested identity scopes: " + data.scope
          : "Your application's Row Level Security policies control data access.";
        status.textContent = "";
        login.hidden = true;
        consent.hidden = false;
      }

      const { data: { session } } = await supabase.auth.getSession();
      if (session) await showAuthorization();
      else {
        status.textContent = "Sign in to review this connection.";
        login.hidden = false;
      }

      login.addEventListener("submit", async (event) => {
        event.preventDefault();
        status.textContent = "Signing in…";
        const { error } = await supabase.auth.signInWithPassword({
          email: document.querySelector("#email").value,
          password: document.querySelector("#password").value,
        });
        if (error) { status.textContent = error.message; return; }
        await showAuthorization();
      });

      document.querySelector("#approve").addEventListener("click", async () => {
        status.textContent = "Approving…";
        const { data, error } = await supabase.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true });
        if (error) { status.textContent = error.message; return; }
        location.assign(data.redirect_url);
      });

      document.querySelector("#deny").addEventListener("click", async () => {
        const { data, error } = await supabase.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true });
        if (error) { status.textContent = error.message; return; }
        location.assign(data.redirect_url);
      });
    </script>
  </body>
</html>`;

const app = {
  fetch(): Response {
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  },
};

if (import.meta.main) Deno.serve(app.fetch);

export default app;
