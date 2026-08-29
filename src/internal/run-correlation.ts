const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const tokenPrefix = "crun1";
const tokenPartPattern = /^[A-Za-z0-9_-]+$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const controlPattern = /[\u0000-\u001f\u007f]/;

export const runCorrelationLimits = Object.freeze({
  clockSkewMs: 5 * 60 * 1000,
  defaultTtlSeconds: 4 * 60 * 60,
  hmacKeyBytes: { min: 32, max: 1024 },
  identifierBytes: 128,
  maxTtlSeconds: 7 * 24 * 60 * 60,
  scopePartBytes: 256,
  tokenBytes: 1024,
});

export type RunCorrelationErrorCode =
  | "ambiguous_carrier"
  | "expired"
  | "invalid_carrier"
  | "invalid_key"
  | "invalid_scope"
  | "invalid_token"
  | "unknown_key";

export class RunCorrelationError extends Error {
  constructor(
    readonly code: RunCorrelationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RunCorrelationError";
  }
}

export interface RunCorrelationScope {
  /** Stable builder-project or installed-integration boundary. */
  readonly installation: string;
  /** Stable MCP surface or server boundary inside that installation. */
  readonly surface: string;
  /** Builder-authorized caller, account, or tenant partition. */
  readonly partition: string;
}

export interface RunCorrelationKey {
  readonly version: string;
  readonly secret: string;
  /** Optional wall-clock end of a rotation overlap for a previous key. */
  readonly acceptUntil?: number;
}

export interface RunCorrelationFact {
  readonly schemaVersion: 1;
  /** Scope-bound opaque correlation ID safe for lifecycle events. */
  readonly id: string;
  readonly startedAt: string;
  readonly expiresAt: string;
}

export interface MintRunHandleOptions {
  readonly scope: RunCorrelationScope;
  readonly key: RunCorrelationKey;
  readonly now?: number;
  readonly ttlSeconds?: number;
  /** Deterministic injection for tests; production callers should omit it. */
  readonly nonce?: string;
}

export interface VerifyRunHandleOptions {
  readonly handle: string;
  readonly scope: RunCorrelationScope;
  readonly keys: readonly RunCorrelationKey[];
  readonly now?: number;
}

interface TokenPayload {
  readonly v: 1;
  readonly k: string;
  readonly n: string;
  readonly s: number;
  readonly e: number;
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function fail(
  code: RunCorrelationErrorCode,
  message: string,
): RunCorrelationError {
  return new RunCorrelationError(code, message);
}

function validateIdentifier(
  value: string,
  label: string,
  code: RunCorrelationErrorCode = "invalid_token",
): void {
  if (
    !identifierPattern.test(value) ||
    byteLength(value) > runCorrelationLimits.identifierBytes
  ) {
    throw fail(code, `${label} must be a bounded ASCII identifier.`);
  }
}

function validateNonce(value: string): void {
  validateIdentifier(value, "Run nonce");
  if (byteLength(value) < 16) {
    throw fail("invalid_token", "Run nonce must contain at least 16 bytes.");
  }
}

function validateScopePart(value: string, label: string): void {
  if (
    !value ||
    value !== value.trim() ||
    value !== value.normalize("NFC") ||
    controlPattern.test(value) ||
    byteLength(value) > runCorrelationLimits.scopePartBytes
  ) {
    throw fail(
      "invalid_scope",
      `${label} must be bounded normalized text without control characters.`,
    );
  }
}

function validateScope(scope: RunCorrelationScope): void {
  validateScopePart(scope.installation, "Run installation");
  validateScopePart(scope.surface, "Run surface");
  validateScopePart(scope.partition, "Run partition");
}

function validateKey(key: RunCorrelationKey): void {
  validateIdentifier(key.version, "Run key version", "invalid_key");
  const keyBytes = byteLength(key.secret);
  if (
    keyBytes < runCorrelationLimits.hmacKeyBytes.min ||
    keyBytes > runCorrelationLimits.hmacKeyBytes.max
  ) {
    throw fail(
      "invalid_key",
      `Run HMAC keys must be ${runCorrelationLimits.hmacKeyBytes.min}-${runCorrelationLimits.hmacKeyBytes.max} encoded bytes.`,
    );
  }
  if (
    key.acceptUntil !== undefined &&
    (!Number.isSafeInteger(key.acceptUntil) || key.acceptUntil < 0)
  ) {
    throw fail("invalid_key", "Run key overlap expiry must be a timestamp.");
  }
}

function validateNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw fail("invalid_token", "Run clock must be a valid timestamp.");
  }
}

function framed(parts: readonly string[]): Uint8Array<ArrayBuffer> {
  const values = parts.map((part) => encoder.encode(part));
  const total = values.reduce((sum, value) => sum + 4 + value.byteLength, 0);
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const value of values) {
    view.setUint32(offset, value.byteLength);
    offset += 4;
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

function base64UrlEncode(value: Uint8Array<ArrayBuffer>): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!value || !tokenPartPattern.test(value)) {
    throw fail("invalid_token", "Run handle encoding is invalid.");
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(
      value.replaceAll("-", "+").replaceAll("_", "/") + padding,
    );
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw fail("invalid_token", "Run handle encoding is invalid.");
  }
}

function canonicalPayload(payload: TokenPayload): string {
  return JSON.stringify({
    v: payload.v,
    k: payload.k,
    n: payload.n,
    s: payload.s,
    e: payload.e,
  });
}

function parsePayload(segment: string): TokenPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(base64UrlDecode(segment)));
  } catch (error) {
    if (error instanceof RunCorrelationError) throw error;
    throw fail("invalid_token", "Run handle payload is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw fail("invalid_token", "Run handle payload is invalid.");
  }
  const candidate = parsed as Partial<Record<keyof TokenPayload, unknown>>;
  if (
    candidate.v !== 1 ||
    typeof candidate.k !== "string" ||
    typeof candidate.n !== "string" ||
    !Number.isSafeInteger(candidate.s) ||
    !Number.isSafeInteger(candidate.e)
  ) {
    throw fail("invalid_token", "Run handle payload is invalid.");
  }
  const payload: TokenPayload = {
    v: 1,
    k: candidate.k,
    n: candidate.n,
    s: candidate.s as number,
    e: candidate.e as number,
  };
  validateIdentifier(payload.k, "Run key version");
  validateNonce(payload.n);
  const canonical = base64UrlEncode(encoder.encode(canonicalPayload(payload)));
  if (canonical !== segment) {
    throw fail("invalid_token", "Run handle payload is not canonical.");
  }
  return payload;
}

async function importedKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function signatureInput(
  scope: RunCorrelationScope,
  payloadSegment: string,
): Uint8Array<ArrayBuffer> {
  return framed([
    "chumbo.run-correlation.v1",
    scope.installation,
    scope.surface,
    scope.partition,
    payloadSegment,
  ]);
}

function validateTimes(
  payload: TokenPayload,
  now: number,
  mode: "mint" | "verify",
): void {
  if (
    !Number.isSafeInteger(payload.s) ||
    !Number.isSafeInteger(payload.e) ||
    payload.s < 0 ||
    payload.e <= payload.s ||
    payload.e - payload.s > runCorrelationLimits.maxTtlSeconds * 1000
  ) {
    throw fail("invalid_token", "Run handle time bounds are invalid.");
  }
  if (payload.s > now + runCorrelationLimits.clockSkewMs) {
    throw fail("invalid_token", "Run handle starts too far in the future.");
  }
  if (mode === "verify" && now >= payload.e) {
    throw fail("expired", "Run handle has expired.");
  }
}

export async function mintRunHandle(
  options: MintRunHandleOptions,
): Promise<string> {
  const now = options.now ?? Date.now();
  const ttlSeconds =
    options.ttlSeconds ?? runCorrelationLimits.defaultTtlSeconds;
  const nonce = options.nonce ?? crypto.randomUUID();
  validateNow(now);
  validateScope(options.scope);
  validateKey(options.key);
  validateNonce(nonce);
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > runCorrelationLimits.maxTtlSeconds
  ) {
    throw fail(
      "invalid_token",
      `Run TTL must be an integer from 1 to ${runCorrelationLimits.maxTtlSeconds} seconds.`,
    );
  }
  if (options.key.acceptUntil !== undefined && now >= options.key.acceptUntil) {
    throw fail("expired", "Run key rotation overlap has ended.");
  }

  const payload: TokenPayload = {
    v: 1,
    k: options.key.version,
    n: nonce,
    s: now,
    e: now + ttlSeconds * 1000,
  };
  validateTimes(payload, now, "mint");
  const payloadSegment = base64UrlEncode(
    encoder.encode(canonicalPayload(payload)),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importedKey(options.key.secret),
    signatureInput(options.scope, payloadSegment),
  );
  const handle = `${tokenPrefix}.${payloadSegment}.${base64UrlEncode(new Uint8Array(signature))}`;
  if (byteLength(handle) > runCorrelationLimits.tokenBytes) {
    throw fail("invalid_token", "Run handle exceeds the encoded size limit.");
  }
  return handle;
}

export async function verifyRunHandle(
  options: VerifyRunHandleOptions,
): Promise<RunCorrelationFact> {
  const now = options.now ?? Date.now();
  validateNow(now);
  validateScope(options.scope);
  if (
    !options.handle ||
    byteLength(options.handle) > runCorrelationLimits.tokenBytes
  ) {
    throw fail("invalid_token", "Run handle exceeds the encoded size limit.");
  }
  const parts = options.handle.split(".");
  if (parts.length !== 3 || parts[0] !== tokenPrefix) {
    throw fail("invalid_token", "Run handle format is invalid.");
  }
  const payloadSegment = parts[1];
  const signatureSegment = parts[2];
  if (!payloadSegment || !signatureSegment) {
    throw fail("invalid_token", "Run handle format is invalid.");
  }
  const payload = parsePayload(payloadSegment);
  validateTimes(payload, now, "verify");

  const versions = new Set<string>();
  let selected: RunCorrelationKey | undefined;
  for (const key of options.keys) {
    validateKey(key);
    if (versions.has(key.version)) {
      throw fail("invalid_key", "Run key versions must be unique.");
    }
    versions.add(key.version);
    if (key.version === payload.k) selected = key;
  }
  if (!selected) {
    throw fail("unknown_key", "Run handle key version is not accepted.");
  }
  if (selected.acceptUntil !== undefined && now >= selected.acceptUntil) {
    throw fail("expired", "Run key rotation overlap has ended.");
  }

  const signature = base64UrlDecode(signatureSegment);
  if (
    signature.byteLength !== 32 ||
    base64UrlEncode(signature) !== signatureSegment
  ) {
    throw fail("invalid_token", "Run handle signature is invalid.");
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    await importedKey(selected.secret),
    signature,
    signatureInput(options.scope, payloadSegment),
  );
  if (!valid) {
    throw fail("invalid_token", "Run handle signature is invalid.");
  }

  return Object.freeze({
    schemaVersion: 1 as const,
    id: `run_${signatureSegment}`,
    startedAt: new Date(payload.s).toISOString(),
    expiresAt: new Date(payload.e).toISOString(),
  });
}

function carrierValue(carrier: unknown, name: string): string | undefined {
  if (!carrier || typeof carrier !== "object" || Array.isArray(carrier)) {
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(carrier, name)) return undefined;
  const value = (carrier as Record<string, unknown>)[name];
  if (typeof value !== "string" || !value) {
    throw fail("invalid_carrier", `Run carrier ${name} must be a string.`);
  }
  return value;
}

/**
 * Resolve one explicit handle from either a controlled MCP request or a
 * selected run-aware tool. Time proximity and client sessions are never used.
 */
export function resolveRunHandle(input: {
  readonly requestMeta?: unknown;
  readonly toolArguments?: unknown;
  readonly argumentName?: string;
}): string | null {
  const metadataHandle = carrierValue(input.requestMeta, "dev.chumbo/run");
  const argumentHandle = carrierValue(
    input.toolArguments,
    input.argumentName ?? "run_id",
  );
  if (
    metadataHandle !== undefined &&
    argumentHandle !== undefined &&
    metadataHandle !== argumentHandle
  ) {
    throw fail(
      "ambiguous_carrier",
      "Run metadata and tool argument identify different runs.",
    );
  }
  return metadataHandle ?? argumentHandle ?? null;
}
