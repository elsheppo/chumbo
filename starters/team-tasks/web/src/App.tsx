import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { Consent } from "./Consent.tsx";
import { SignIn } from "./SignIn.tsx";
import { supabase } from "./supabase.ts";
import { Workspace } from "./Workspace.tsx";

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) =>
      setSession(next),
    );
    return () => data.subscription.unsubscribe();
  }, []);

  if (session === undefined) return <main className="center">Loading…</main>;

  // Supabase Auth's OAuth 2.1 server sends MCP clients here
  // ([auth.oauth_server] authorization_url_path in supabase/config.toml).
  if (location.pathname === "/oauth/consent") {
    const authorizationId = new URL(location.href).searchParams.get(
      "authorization_id",
    );
    return (
      <main className="center">
        {session ? (
          <Consent authorizationId={authorizationId} />
        ) : (
          <SignIn intro="Sign in to review the agent connection request." />
        )}
      </main>
    );
  }

  return session ? (
    <Workspace session={session} />
  ) : (
    <main className="center">
      <SignIn intro="Team tasks for people and their agents." />
    </main>
  );
}
