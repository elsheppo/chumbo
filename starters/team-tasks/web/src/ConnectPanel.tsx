import { useState } from "react";
import { mcpUrl } from "./supabase.ts";

const snippets = (url: string) => [
  {
    label: "Claude Code",
    text: `claude mcp add --transport http team-tasks ${url}`,
  },
  {
    label: "Cursor (.cursor/mcp.json)",
    text: JSON.stringify({ mcpServers: { "team-tasks": { url } } }, null, 2),
  },
  {
    label: "Claude.ai / Claude Desktop",
    text: `Settings → Connectors → Add custom connector → ${url}`,
  },
];

export function ConnectPanel() {
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(label: string, text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <aside className="card stack" aria-label="Connect an agent">
      <h2>Connect an agent</h2>
      <p className="muted">
        Your agent signs in as you and sees exactly the teams and tasks you see
        here.
      </p>
      <code className="url">{mcpUrl}</code>
      {snippets(mcpUrl).map(({ label, text }) => (
        <div key={label} className="stack tight">
          <div className="row spread">
            <small>{label}</small>
            <button className="link" onClick={() => copy(label, text)}>
              {copied === label ? "Copied" : "Copy"}
            </button>
          </div>
          <pre>{text}</pre>
        </div>
      ))}
    </aside>
  );
}
