import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { access, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const MAX_RESPONSE_BYTES = 64 * 1_024;
const MAX_SNIPPET_BYTES = 8 * 1_024;
const SECRET = /^[A-Za-z0-9_-]{43,128}$/u;
const USER_CODE = /^[23456789A-HJ-NP-Z]{5}-[23456789A-HJ-NP-Z]{5}$/u;
const PROJECT_REF = /^[a-z0-9]{20}$/u;
const BINDING_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CLOUD_SECRET_NAME = "CHUMBO_CLOUD_ANALYTICS_BRIDGE_HMAC_V1";

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
  parse: (body: unknown) => T,
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
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw invalidResponse();
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw invalidResponse();
  }
  if (!response.ok) {
    const envelope =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : undefined;
    const error =
      envelope?.error &&
      typeof envelope.error === "object" &&
      !Array.isArray(envelope.error)
        ? (envelope.error as Record<string, unknown>)
        : undefined;
    const message =
      typeof error?.message === "string" &&
      error.message.length > 0 &&
      error.message.length <= 500 &&
      !/[\u0000-\u001f\u007f]/u.test(error.message)
        ? error.message
        : "Chumbo Cloud setup did not finish.";
    const code =
      typeof error?.code === "string" &&
      /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
        ? error.code
        : "request_failed";
    throw new CloudSetupApiError(message, code, error?.retryable === true);
  }
  try {
    return parse(body);
  } catch (error) {
    if (error instanceof CloudSetupApiError) throw error;
    throw invalidResponse();
  }
}

function invalidResponse(): CloudSetupApiError {
  return new CloudSetupApiError(
    "Chumbo Cloud returned an unreadable response.",
    "invalid_response",
    true,
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResponse();
  }
  return value as Record<string, unknown>;
}

function versioned(value: unknown): Record<string, unknown> {
  const body = record(value);
  if (body.schemaVersion !== 1) throw invalidResponse();
  return body;
}

function boundedText(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalidResponse();
  }
  return value;
}

function timestamp(value: unknown): string {
  const text = boundedText(value, 64);
  if (!Number.isFinite(new Date(text).getTime())) throw invalidResponse();
  return text;
}

export function normalizeCloudOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(
      "--cloud-url must be an HTTPS origin or an HTTP loopback origin without a path, credentials, query, or fragment.",
    );
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/") ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new Error(
      "--cloud-url must be an HTTPS origin or an HTTP loopback origin without a path, credentials, query, or fragment.",
    );
  }
  return url.origin;
}

function parseDeviceStart(value: unknown, origin: string): DeviceStart {
  const body = versioned(value);
  const verificationUriComplete = boundedText(
    body.verificationUriComplete,
    2_048,
  );
  const verificationUrl = new URL(verificationUriComplete);
  if (verificationUrl.origin !== origin) throw invalidResponse();
  const intervalSeconds = body.intervalSeconds;
  if (
    typeof intervalSeconds !== "number" ||
    !Number.isInteger(intervalSeconds) ||
    intervalSeconds < 1 ||
    intervalSeconds > 10
  ) {
    throw invalidResponse();
  }
  const deviceCode = boundedText(body.deviceCode, 128);
  const userCode = boundedText(body.userCode, 11);
  if (!SECRET.test(deviceCode) || !USER_CODE.test(userCode)) {
    throw invalidResponse();
  }
  return {
    deviceCode,
    userCode,
    verificationUriComplete,
    expiresAt: timestamp(body.expiresAt),
    intervalSeconds,
  };
}

function parseDeviceToken(value: unknown): DeviceToken {
  const body = versioned(value);
  const accessToken = boundedText(body.accessToken, 128);
  if (!SECRET.test(accessToken) || body.tokenType !== "Bearer") {
    throw invalidResponse();
  }
  return { accessToken, expiresAt: timestamp(body.expiresAt) };
}

function validatedSnippet(value: unknown, exportName: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SNIPPET_BYTES ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw invalidResponse();
  }
  const snippet = value;
  if (
    new TextEncoder().encode(snippet).byteLength > MAX_SNIPPET_BYTES ||
    !snippet.includes(`export async function ${exportName}(`) ||
    !snippet.includes(CLOUD_SECRET_NAME)
  ) {
    throw invalidResponse();
  }
  return snippet;
}

function parseTask(value: unknown): CloudSetupTask {
  const body = versioned(value);
  const project = record(body.project);
  const integration = record(body.integration);
  const sessionId = boundedText(body.sessionId, 64);
  const projectRef = boundedText(project.ref, 20);
  const functionSlug = boundedText(body.functionSlug, 128);
  if (
    !SESSION_ID.test(sessionId) ||
    !PROJECT_REF.test(projectRef) ||
    !BINDING_ID.test(functionSlug) ||
    integration.secretName !== CLOUD_SECRET_NAME
  ) {
    throw invalidResponse();
  }
  return {
    sessionId,
    project: { ref: projectRef, name: boundedText(project.name, 160) },
    functionSlug,
    integration: {
      secretName: CLOUD_SECRET_NAME,
      onEventSnippet: validatedSnippet(
        integration.onEventSnippet,
        "chumboCloudOnEvent",
      ),
      onSurfaceSnippet: validatedSnippet(
        integration.onSurfaceSnippet,
        "chumboCloudOnSurface",
      ),
    },
  };
}

function parseVerification(value: unknown): {
  state: "pending" | "verified";
  nextAction?: string;
} {
  const body = versioned(value);
  if (body.state !== "pending" && body.state !== "verified") {
    throw invalidResponse();
  }
  return {
    state: body.state,
    ...(body.nextAction === undefined
      ? {}
      : { nextAction: boundedText(body.nextAction, 500) }),
  };
}

export function createCloudSetupClient(
  origin: string,
  fetchImplementation: typeof fetch = fetch,
) {
  const base = normalizeCloudOrigin(origin);
  const call = <T>(
    path: string,
    init: RequestInit,
    parse: (body: unknown) => T,
  ) =>
    jsonRequest<T>(
      fetchImplementation,
      new URL(path, base).toString(),
      init,
      parse,
    );
  return {
    start: (input: {
      codeChallenge: string;
      deviceName: string;
      agentName: string;
    }) =>
      call<DeviceStart>(
        "/api/setup/device/start",
        {
          method: "POST",
          body: JSON.stringify(input),
        },
        (body) => parseDeviceStart(body, base),
      ),
    token: (deviceCode: string, codeVerifier: string) =>
      call<DeviceToken>(
        "/api/setup/device/token",
        {
          method: "POST",
          body: JSON.stringify({ deviceCode, codeVerifier }),
        },
        parseDeviceToken,
      ),
    task: (token: string) =>
      call<CloudSetupTask>(
        "/api/setup/device/task",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        },
        parseTask,
      ),
    event: (token: string, event: CloudSetupEvent) =>
      call<unknown>(
        "/api/setup/device/events",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify(event),
        },
        (body) => body,
      ),
    verify: (token: string) =>
      call<{ state: "pending" | "verified"; nextAction?: string }>(
        "/api/setup/device/verify",
        { method: "POST", headers: { Authorization: `Bearer ${token}` } },
        parseVerification,
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
  changes: CloudPatchChange[];
}

export interface CloudPatchChange {
  path: string;
  action: "create" | "update";
  addedText: string;
}

export interface CloudDeployCommand {
  command: string;
  args: string[];
}

function functionVerifiesJwt(config: string, functionSlug: string): boolean {
  const escapedSlug = functionSlug.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const section = new RegExp(
    `^\\[functions\\.(?:${escapedSlug}|["']${escapedSlug}["'])\\]\\s*$`,
    "mu",
  ).exec(config);
  if (!section) return false;
  const remainder = config.slice(section.index + section[0].length);
  const nextSection = /^\s*\[/mu.exec(remainder);
  const body = remainder.slice(0, nextSection?.index ?? remainder.length);
  return /^\s*verify_jwt\s*=\s*true\s*(?:#.*)?$/mu.test(body);
}

export function planCloudDeployCommand(input: {
  root: string;
  functionSlug: string;
  projectRef: string;
  packageJson: string | null;
  supabaseConfig: string | null;
  hasImportMap: boolean;
  hasLocalSupabase: boolean;
}): CloudDeployCommand {
  let hasSupabaseScript = false;
  if (input.packageJson) {
    try {
      const manifest = JSON.parse(input.packageJson) as {
        scripts?: Record<string, unknown>;
      };
      hasSupabaseScript = typeof manifest.scripts?.supabase === "string";
    } catch {
      // An invalid package manifest is not a safe source for a deploy command.
    }
  }
  const command = hasSupabaseScript
    ? "npm"
    : input.hasLocalSupabase
      ? join(input.root, "node_modules", ".bin", "supabase")
      : "supabase";
  const args = hasSupabaseScript ? ["run", "--silent", "supabase", "--"] : [];
  args.push("functions", "deploy", input.functionSlug);
  if (
    !input.supabaseConfig ||
    !functionVerifiesJwt(input.supabaseConfig, input.functionSlug)
  ) {
    args.push("--no-verify-jwt");
  }
  args.push("--yes", "--project-ref", input.projectRef);
  if (input.hasImportMap) {
    args.push(
      "--import-map",
      relative(
        input.root,
        join(
          input.root,
          "supabase",
          "functions",
          input.functionSlug,
          "deno.json",
        ),
      ),
      "--use-api",
    );
  }
  return { command, args };
}

async function optionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCloudDeployCommand(input: {
  root: string;
  functionSlug: string;
  projectRef: string;
}): Promise<CloudDeployCommand> {
  const functionDirectory = join(
    input.root,
    "supabase",
    "functions",
    input.functionSlug,
  );
  const [packageJson, supabaseConfig, hasImportMap, hasLocalSupabase] =
    await Promise.all([
      optionalFile(join(input.root, "package.json")),
      optionalFile(join(input.root, "supabase", "config.toml")),
      exists(join(functionDirectory, "deno.json")),
      exists(join(input.root, "node_modules", ".bin", "supabase")),
    ]);
  return planCloudDeployCommand({
    ...input,
    packageJson,
    supabaseConfig,
    hasImportMap,
    hasLocalSupabase,
  });
}

function findCreateSupabaseMcpCall(source: string): number {
  const identifier = /\bcreateSupabaseMcp\b/gu;
  for (const match of source.matchAll(identifier)) {
    let cursor = match.index + match[0].length;
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] === "<") {
      let depth = 0;
      for (; cursor < source.length; cursor += 1) {
        if (source[cursor] === "<") depth += 1;
        if (source[cursor] === ">" && --depth === 0) {
          cursor += 1;
          break;
        }
      }
      if (depth !== 0) continue;
      while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    }
    if (source[cursor] === "(") return match.index;
  }
  return -1;
}

export function planCloudPatch(input: {
  root: string;
  functionSlug: string;
  currentSource: string;
  currentAdapter: string | null;
  onEventSnippet: string;
  onSurfaceSnippet: string;
}): CloudPatchPlan {
  if (!BINDING_ID.test(input.functionSlug)) {
    throw new Error("Cloud returned an invalid Edge Function name.");
  }
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
  const functionAdditions: string[] = [];
  const importLine =
    'import { chumboCloudOnEvent, chumboCloudOnSurface } from "./chumbo-cloud.ts";';
  if (!functionSource.includes(importLine)) {
    functionSource = `${importLine}\n${functionSource}`;
    functionAdditions.push(`${importLine}\n`);
  }
  const call = findCreateSupabaseMcpCall(functionSource);
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
    const addedText = `  ${additions.join("\n  ")}`;
    functionSource = `${functionSource.slice(0, opening + 1)}\n${addedText}${functionSource.slice(opening + 1)}`;
    functionAdditions.push(`${addedText}\n`);
  }
  const changes: CloudPatchChange[] = [];
  if (functionAdditions.length > 0) {
    changes.push({
      path: functionPath,
      action: "update",
      addedText: functionAdditions.join(""),
    });
  }
  if (input.currentAdapter === null) {
    changes.push({ path: adapterPath, action: "create", addedText: adapter });
  }
  return {
    adapterPath,
    functionPath,
    adapter,
    functionSource,
    changed: changes.length > 0,
    changes,
  };
}

export function formatCloudPatchPlan(
  plan: CloudPatchPlan,
  root: string,
): string {
  if (plan.changes.length === 0) return "No local file changes are needed.";
  return plan.changes
    .map((change) => {
      const lines = change.addedText
        .replace(/\n$/u, "")
        .split("\n")
        .map((line) => `+ ${line}`)
        .join("\n");
      return `${change.action} ${relative(root, change.path)}\n${lines}`;
    })
    .join("\n\n");
}

export function cloudSetupNeedsMachineConfirmation(input: {
  machine: boolean;
  yes: boolean;
  planOnly: boolean;
}): boolean {
  return input.machine && !input.yes && !input.planOnly;
}

export async function reportCloudSetupEvent(
  send: (event: CloudSetupEvent) => Promise<unknown>,
  event: CloudSetupEvent,
  warn: (message: string) => void,
): Promise<void> {
  try {
    await send(event);
  } catch {
    warn(`Cloud could not record ${event.kind}; setup continued.`);
  }
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
