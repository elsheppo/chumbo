export const REQUEST_TIMEOUT_MS = 10_000;
export const DISCOVERY_BODY_LIMIT = 256 * 1024;

export class DoctorRequestError extends Error {
  constructor(
    readonly kind: "timeout" | "failed",
    readonly url: string,
  ) {
    super(
      kind === "timeout"
        ? `timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds at ${url}`
        : `no response from ${url}`,
    );
  }
}

/**
 * Every doctor request has a deadline. Requests that carry a credential never
 * follow a redirect, so a token cannot be forwarded to another host.
 */
export async function timedFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const carriesCredential = headers.has("authorization");
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(carriesCredential ? { redirect: "error" as const } : {}),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    throw new DoctorRequestError(timedOut ? "timeout" : "failed", url);
  }
}

/** Reads at most `limit` bytes of text; reports when the body was larger. */
export async function readCapped(
  response: Response,
  limit = DISCOVERY_BODY_LIMIT,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: await response.text(), truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text, truncated: false };
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel().catch(() => undefined);
      return { text, truncated: true };
    }
    text += decoder.decode(value, { stream: true });
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname);
}

/** Discovered URLs must be https, except on a loopback host. */
export function acceptableUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return url;
    if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Removes ANSI escapes and control characters from server-supplied text. */
export function stripControl(value: string): string {
  return value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}
