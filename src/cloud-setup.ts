import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CloudSetupEvent {
  kind:
    | "inspection_started"
    | "inspection_completed"
    | "change_proposed"
    | "change_applied"
    | "checks_started"
    | "checks_completed"
    | "deployment_started"
    | "deployment_completed"
    | "verification_started"
    | "session_completed"
    | "session_failed";
  summary: string;
  detail?: string;
}

interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUriComplete: string;
  expiresAt: string;
  intervalSeconds: number;
}

interface DeviceToken {
  accessToken: string;
  expiresAt: string;
}

export interface CloudSetupTask {
  sessionId: string;
  project: { ref: string; name: string };
  functionSlug: string;
  integration: {
    secretName: string;
    onEventSnippet: string;
    onSurfaceSnippet: string;
  };
}

export class CloudSetupApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CloudSetupApiError";
  }
}

async function jsonRequest<T>(
  fetchImplementation: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetchImplementation(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new CloudSetupApiError(
      "Chumbo Cloud returned an unreadable response.",
      "invalid_response",
      true,
    );
  }
  if (!response.ok) {
    const error = (
      body as {
        error?: { code?: string; message?: string; retryable?: boolean };
      }
    ).error;
    throw new CloudSetupApiError(
      error?.message ?? "Chumbo Cloud setup did not finish.",
      error?.code ?? "request_failed",
      Boolean(error?.retryable),
    );
  }
  return body as T;
}

export function createCloudSetupClient(
  origin: string,
  fetchImplementation: typeof fetch = fetch,
) {
  const base = new URL(origin).origin;
  const call = <T>(path: string, init: RequestInit) =>
    jsonRequest<T>(fetchImplementation, new URL(path, base).toString(), init);
  return {
    start: (input: {
      codeChallenge: string;
      deviceName: string;
      agentName: string;
    }) =>
      call<DeviceStart>("/api/setup/device/start", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    token: (deviceCode: string, codeVerifier: string) =>
      call<DeviceToken>("/api/setup/device/token", {
        method: "POST",
        body: JSON.stringify({ deviceCode, codeVerifier }),
      }),
    task: (token: string) =>
      call<CloudSetupTask>("/api/setup/device/task", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      }),
    event: (token: string, event: CloudSetupEvent) =>
      call<unknown>("/api/setup/device/events", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(event),
      }),
    verify: (token: string) =>
      call<{ state: "pending" | "verified"; nextAction?: string }>(
        "/api/setup/device/verify",
        { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      ),
  };
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256")
      .update(verifier, "ascii")
      .digest("base64url"),
  };
}

function matchingBrace(source: string, opening: number): number {
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = opening; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return index;
  }
  return -1;
}

export interface CloudPatchPlan {
  adapterPath: string;
  functionPath: string;
  adapter: string;
  functionSource: string;
  changed: boolean;
}

export function planCloudPatch(input: {
  root: string;
  functionSlug: string;
  currentSource: string;
  currentAdapter: string | null;
  onEventSnippet: string;
  onSurfaceSnippet: string;
}): CloudPatchPlan {
  const functionPath = join(
    input.root,
    "supabase",
    "functions",
    input.functionSlug,
    "index.ts",
  );
  const adapterPath = join(
    input.root,
    "supabase",
    "functions",
    input.functionSlug,
    "chumbo-cloud.ts",
  );
  const adapter = `// Generated by Chumbo Cloud. Re-run \`chumbo cloud setup\` to refresh.\n${input.onEventSnippet}\n\n${input.onSurfaceSnippet}\n`;
  if (input.currentAdapter !== null && input.currentAdapter !== adapter) {
    throw new Error(
      "chumbo-cloud.ts contains local changes. Move or reconcile them before setup continues.",
    );
  }
  let functionSource = input.currentSource;
  const importLine =
    'import { chumboCloudOnEvent, chumboCloudOnSurface } from "./chumbo-cloud.ts";';
  if (!functionSource.includes(importLine))
    functionSource = `${importLine}\n${functionSource}`;
  const call = functionSource.indexOf("createSupabaseMcp(");
  if (call < 0)
    throw new Error(
      `Could not find createSupabaseMcp(...) in ${input.functionSlug}/index.ts.`,
    );
  const opening = functionSource.indexOf("{", call);
  const closing = opening < 0 ? -1 : matchingBrace(functionSource, opening);
  if (closing < 0)
    throw new Error(
      "Could not safely read the createSupabaseMcp configuration.",
    );
  const config = functionSource.slice(opening, closing + 1);
  const hasEvent = /\bonEvent\s*:/u.test(config);
  const hasSurface = /\bonSurface\s*:/u.test(config);
  if (
    (hasEvent && !config.includes("chumboCloudOnEvent")) ||
    (hasSurface && !config.includes("chumboCloudOnSurface"))
  ) {
    throw new Error(
      "This MCP already has a custom lifecycle hook. Chumbo will not overwrite it automatically.",
    );
  }
  const additions = [
    !hasEvent ? "onEvent: chumboCloudOnEvent," : "",
    !hasSurface ? "onSurface: chumboCloudOnSurface," : "",
  ].filter(Boolean);
  if (additions.length > 0) {
    functionSource = `${functionSource.slice(0, opening + 1)}\n  ${additions.join("\n  ")}${functionSource.slice(opening + 1)}`;
  }
  return {
    adapterPath,
    functionPath,
    adapter,
    functionSource,
    changed:
      input.currentAdapter !== adapter ||
      functionSource !== input.currentSource,
  };
}

export async function loadCloudPatch(
  root: string,
  task: CloudSetupTask,
): Promise<CloudPatchPlan> {
  const functionPath = join(
    root,
    "supabase",
    "functions",
    task.functionSlug,
    "index.ts",
  );
  const adapterPath = join(
    root,
    "supabase",
    "functions",
    task.functionSlug,
    "chumbo-cloud.ts",
  );
  const currentSource = await readFile(functionPath, "utf8");
  let currentAdapter: string | null = null;
  try {
    currentAdapter = await readFile(adapterPath, "utf8");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  return planCloudPatch({
    root,
    functionSlug: task.functionSlug,
    currentSource,
    currentAdapter,
    onEventSnippet: task.integration.onEventSnippet,
    onSurfaceSnippet: task.integration.onSurfaceSnippet,
  });
}

export async function applyCloudPatch(plan: CloudPatchPlan): Promise<void> {
  if (!plan.changed) return;
  await writeFile(plan.adapterPath, plan.adapter, {
    encoding: "utf8",
    mode: 0o644,
  });
  await writeFile(plan.functionPath, plan.functionSource, "utf8");
}

export function openPairingUrl(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

export const cloudDeviceName = () =>
  hostname().slice(0, 80) || "local computer";
