import type { OAuthAuthorizationDetails } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { supabase } from "./supabase.ts";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; details: OAuthAuthorizationDetails }
  | { kind: "redirecting" };

export function Consent({
  authorizationId,
}: {
  authorizationId: string | null;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    if (!authorizationId) {
      setState({
        kind: "error",
        message: "This link is missing its authorization_id.",
      });
      return;
    }
    supabase.auth.oauth
      .getAuthorizationDetails(authorizationId)
      .then(({ data, error }) => {
        if (error) return setState({ kind: "error", message: error.message });
        if ("redirect_url" in data && !("authorization_id" in data)) {
          // Already approved earlier: hand control straight back to the client.
          setState({ kind: "redirecting" });
          location.assign(data.redirect_url);
          return;
        }
        setState({ kind: "ready", details: data as OAuthAuthorizationDetails });
      });
  }, [authorizationId]);

  async function decide(approve: boolean) {
    if (!authorizationId) return;
    setState({ kind: "redirecting" });
    const options = { skipBrowserRedirect: true };
    const { data, error } = approve
      ? await supabase.auth.oauth.approveAuthorization(authorizationId, options)
      : await supabase.auth.oauth.denyAuthorization(authorizationId, options);
    if (error) return setState({ kind: "error", message: error.message });
    location.assign(data.redirect_url);
  }

  if (state.kind === "loading") return <p className="card">Loading request…</p>;
  if (state.kind === "redirecting")
    return <p className="card">Returning to your agent…</p>;
  if (state.kind === "error") {
    return (
      <div className="card stack">
        <h1>Cannot connect</h1>
        <p role="alert" className="error">
          {state.message}
        </p>
      </div>
    );
  }

  const { client, user, scope } = state.details;
  return (
    <section className="card stack" aria-label="Connection request">
      <h1>Connect {client.name || "an MCP client"}?</h1>
      <p>
        <strong>{client.name || "This client"}</strong> wants to use Team Tasks
        as <strong>{user.email}</strong>.
      </p>
      <ul className="muted">
        <li>It can read and change tasks in the teams you belong to.</li>
        <li>
          It sees exactly what you see here. Your team's access rules still
          apply.
        </li>
        {scope && <li>Requested scopes: {scope}</li>}
      </ul>
      <div className="row">
        <button className="secondary" onClick={() => decide(false)}>
          Deny
        </button>
        <button onClick={() => decide(true)}>Approve</button>
      </div>
    </section>
  );
}
