import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  listLocalSeedUsers,
  type LocalPersonaDeps,
  type LocalSeedUserSummary,
} from "./local-personas.js";
import type { SetupTarget } from "./project.js";
import { inspectLocalSurfaceStatic } from "./surface-lock.js";
import type { LockedSurfaceEntry } from "./surface-diff.js";
import { runTry } from "./try.js";

export interface DevAppSimulatorHook {
  /** Optional custom HTTP routes mounted under the loopback workbench server. */
  handleRequest?(
    request: IncomingMessage,
    response: ServerResponse,
    workbenchToken: string,
  ): Promise<boolean> | boolean;
  /** Optional HTML snippet embedded in the workbench split-pane shell. */
  panelHtml?(workbenchToken: string): string;
  close?(): Promise<void> | void;
}

export interface DevStartupBanner {
  readonly staticSurface: LockedSurfaceEntry | null;
  readonly seedUsers: readonly LocalSeedUserSummary[];
  readonly lines: readonly string[];
}

/**
 * Strictly read-only, fail-open pre-spawn banner for `chumbo dev`.
 * Never signs in a GoTrue user, never mutates Postgres, and never spawns a
 * post-startup probe that interleaves into `supabase functions serve` stdio.
 */
export async function gatherDevStartupBanner(options: {
  projectRoot: string;
  functionName: string;
  target?: SetupTarget;
  personaDeps?: LocalPersonaDeps;
  staticInspector?: () => Promise<LockedSurfaceEntry | null>;
}): Promise<DevStartupBanner> {
  const [surfaceResult, usersResult] = await Promise.allSettled([
    options.staticInspector
      ? options.staticInspector()
      : inspectLocalSurfaceStatic({
          projectRoot: options.projectRoot,
          functionName: options.functionName,
          target: options.target ?? "edge-function",
          timeoutMs: 1_500,
        }),
    listLocalSeedUsers(options.projectRoot, options.personaDeps),
  ]);

  const staticSurface =
    surfaceResult.status === "fulfilled" ? surfaceResult.value : null;
  const seedUsers = usersResult.status === "fulfilled" ? usersResult.value : [];

  const lines: string[] = [];
  if (staticSurface) {
    const kib = (staticSurface.contextBudget.totalWireBytes / 1024).toFixed(1);
    lines.push(
      `Cold-start surface: ${staticSurface.tools.length} tool(s) · ~${staticSurface.contextBudget.totalPromptTokens} prompt tokens (${kib} KiB) · ${staticSurface.contentDigest.slice(0, 16)}…`,
    );
  }

  const emails = seedUsers
    .map((u) => u.email)
    .filter((email): email is string => Boolean(email));
  if (emails.length > 0) {
    const preview = emails.slice(0, 4).join(", ");
    lines.push(
      `Local seed users: ${preview}${emails.length > 4 ? ` (+${emails.length - 4} more)` : ""} (${emails.length} found)`,
    );
    const firstTool = staticSurface?.tools[0]?.name ?? "whoami";
    if (emails.length >= 2) {
      lines.push(
        `Compare two users in one command:\n  npx chumbo try ${firstTool} --function ${options.functionName} --as ${emails[0]},${emails[1]}`,
      );
    } else {
      lines.push(
        `Try a tool locally:\n  npx chumbo try ${firstTool} --function ${options.functionName} --as ${emails[0]}`,
      );
    }
  }

  return Object.freeze({
    staticSurface,
    seedUsers,
    lines: Object.freeze(lines),
  });
}

export interface StartDevWorkbenchOptions {
  readonly projectRoot: string;
  readonly functionName: string;
  readonly mcpEndpointUrl: string;
  readonly port?: number;
  readonly envFile?: string;
  readonly personaDeps?: LocalPersonaDeps;
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly appSimulator?: DevAppSimulatorHook;
}

export interface RunningDevWorkbench {
  readonly url: string;
  readonly port: number;
  readonly token: string;
  close(): Promise<void>;
}

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function readJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    let raw = "";
    request.on("data", (chunk: Buffer | string) => {
      raw += String(chunk);
      if (raw.length > 512 * 1024) {
        rejectPromise(new Error("Request body exceeds 512 KiB."));
      }
    });
    request.on("end", () => {
      if (!raw.trim()) {
        resolvePromise({});
        return;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          rejectPromise(new Error("Request body must be a JSON object."));
          return;
        }
        resolvePromise(parsed as Record<string, unknown>);
      } catch {
        rejectPromise(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", rejectPromise);
  });
}

function renderWorkbenchHtml(options: {
  functionName: string;
  mcpEndpointUrl: string;
  token: string;
  appPanelHtml?: string;
}): string {
  const safeToken = escapeHtmlAttr(options.token);
  const safeFn = escapeHtmlAttr(options.functionName);
  const safeUrl = escapeHtmlAttr(options.mcpEndpointUrl);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Chumbo Dev Workbench — ${safeFn}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; background: #0f1115; color: #eceef2; }
    header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 16px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    section { background: #171b22; border: 1px solid #262c36; border-radius: 8px; padding: 14px; }
    pre { overflow: auto; background: #0b0d11; padding: 10px; border-radius: 6px; font-size: 12px; }
    input, textarea, button { font: inherit; background: #0b0d11; color: #eceef2; border: 1px solid #303744; border-radius: 6px; padding: 6px 8px; }
    button { background: #2563eb; border-color: #2563eb; cursor: pointer; }
  </style>
</head>
<body data-workbench-token="${safeToken}">
  <header>
    <h1>Chumbo Dev Workbench: ${safeFn}</h1>
    <code>${safeUrl}</code>
  </header>
  <div class="grid">
    <section>
      <h2>Two-Persona Tool Runner</h2>
      <p>Sign-ins execute only when you click Run.</p>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <input id="tool" placeholder="Tool name (blank for discovery)" />
        <input id="personas" placeholder="Personas, e.g. alice@example.com,bob@example.com" value="anon" />
        <textarea id="args" rows="3">{}</textarea>
        <label><input id="confirmWrite" type="checkbox" /> Allow non-read-only tool call</label>
        <button id="runBtn" type="button">Run</button>
      </div>
      <pre id="output">Ready.</pre>
    </section>
    <section>
      <h2>Surface &amp; App Preview</h2>
      <pre id="surface">Loading surface…</pre>
      ${options.appPanelHtml ?? ""}
    </section>
  </div>
  <script>
    const token = document.body.dataset.workbenchToken;
    fetch("/__chumbo/workbench/surface").then((r) => r.json()).then((d) => {
      document.getElementById("surface").textContent = JSON.stringify(d, null, 2);
    }).catch(() => {});
    document.getElementById("runBtn").addEventListener("click", async () => {
      const out = document.getElementById("output");
      out.textContent = "Running…";
      try {
        const res = await fetch("/__chumbo/workbench/try", {
          method: "POST",
          headers: { "content-type": "application/json", "x-chumbo-workbench-token": token },
          body: JSON.stringify({
            tool: document.getElementById("tool").value.trim() || null,
            as: document.getElementById("personas").value.split(",").map((s) => s.trim()).filter(Boolean),
            args: JSON.parse(document.getElementById("args").value || "{}"),
            confirmWrite: document.getElementById("confirmWrite").checked,
          }),
        });
        out.textContent = JSON.stringify(await res.json(), null, 2);
      } catch (err) {
        out.textContent = String(err);
      }
    });
  </script>
</body>
</html>`;
}

export async function startDevWorkbench(
  options: StartDevWorkbenchOptions,
): Promise<RunningDevWorkbench> {
  const token = randomBytes(32).toString("hex");
  let boundPort = options.port ?? 0;

  const isAllowedOrigin = (originHeader: string | undefined): boolean => {
    if (!originHeader) return true;
    return (
      originHeader === `http://127.0.0.1:${boundPort}` ||
      originHeader === `http://localhost:${boundPort}`
    );
  };

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${boundPort}`);
    try {
      if (options.appSimulator?.handleRequest) {
        const handled = await options.appSimulator.handleRequest(
          request,
          response,
          token,
        );
        if (handled) return;
      }

      if (request.method === "GET" && url.pathname === "/") {
        const html = renderWorkbenchHtml({
          functionName: options.functionName,
          mcpEndpointUrl: options.mcpEndpointUrl,
          token,
          appPanelHtml: options.appSimulator?.panelHtml?.(token),
        });
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(html);
        return;
      }

      if (
        request.method === "GET" &&
        url.pathname === "/__chumbo/workbench/personas"
      ) {
        const users = await listLocalSeedUsers(
          options.projectRoot,
          options.personaDeps,
        ).catch(() => []);
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(
          JSON.stringify({
            personas: [{ id: "anon", email: null, kind: "anon" }, ...users],
          }),
        );
        return;
      }

      if (
        request.method === "GET" &&
        url.pathname === "/__chumbo/workbench/surface"
      ) {
        const entry = await inspectLocalSurfaceStatic({
          projectRoot: options.projectRoot,
          functionName: options.functionName,
          target: "edge-function",
          timeoutMs: 2_500,
        });
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify({ surface: entry }));
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/__chumbo/workbench/try"
      ) {
        const headerToken = request.headers["x-chumbo-workbench-token"];
        if (headerToken !== token || !isAllowedOrigin(request.headers.origin)) {
          response.writeHead(403, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ error: "forbidden_workbench_request" }),
          );
          return;
        }
        const body = await readJsonBody(request);
        const tool =
          typeof body.tool === "string" && body.tool.trim().length > 0
            ? body.tool.trim()
            : null;
        const asList = Array.isArray(body.as)
          ? body.as.filter(
              (entry): entry is string => typeof entry === "string",
            )
          : ["anon"];
        const args =
          body.args &&
          typeof body.args === "object" &&
          !Array.isArray(body.args)
            ? (body.args as Record<string, unknown>)
            : {};
        const report = await runTry({
          cwd: options.projectRoot,
          functionName: options.functionName,
          url: options.mcpEndpointUrl,
          tool,
          args,
          as: asList,
          envFile: options.envFile,
          yes: body.confirmWrite === true,
          json: true,
          fetchImpl: options.fetchImpl,
          personaDeps: options.personaDeps,
        });
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify(report));
        return;
      }

      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(boundPort, "127.0.0.1", () => {
      server.removeListener("error", rejectPromise);
      resolvePromise();
    });
  });

  const address = server.address() as AddressInfo;
  boundPort = address.port;

  return {
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    token,
    async close() {
      await options.appSimulator?.close?.();
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      });
    },
  };
}
