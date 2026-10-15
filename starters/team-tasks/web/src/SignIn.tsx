import { type FormEvent, useState } from "react";
import { supabase } from "./supabase.ts";

export function SignIn({ intro }: { intro: string }) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const { error } =
      mode === "sign-in"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    setBusy(false);
    if (error) setMessage(error.message);
  }

  return (
    <form className="card stack" onSubmit={submit} aria-label={mode}>
      <h1>Team Tasks</h1>
      <p className="muted">{intro}</p>
      <label>
        Email
        <input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </label>
      <label>
        Password
        <input
          type="password"
          autoComplete={
            mode === "sign-in" ? "current-password" : "new-password"
          }
          minLength={6}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </label>
      {message && (
        <p role="alert" className="error">
          {message}
        </p>
      )}
      <button disabled={busy}>
        {mode === "sign-in" ? "Sign in" : "Create account"}
      </button>
      <button
        type="button"
        className="link"
        onClick={() => setMode(mode === "sign-in" ? "sign-up" : "sign-in")}
      >
        {mode === "sign-in"
          ? "New here? Create an account"
          : "Have an account? Sign in"}
      </button>
      <p className="hint">
        Local demo users: <code>alice@example.com</code> and{" "}
        <code>bob@example.com</code>, password <code>password123</code>.
      </p>
    </form>
  );
}
