import type { DoctorCheck } from "./doctor.js";
import {
  acceptableUrl,
  DoctorRequestError,
  isLoopbackHost,
  readCapped,
  timedFetch,
} from "./doctor-http.js";

interface Fetched {
  url: string;
  status: number;
  json: Record<string, unknown> | null;
  /** Why no response was read: a timeout, a refused body, or no connection. */
  problem?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** GET only. Discovery never registers a client or writes anything. */
async function getJson(url: string): Promise<Fetched> {
  try {
    const response = await timedFetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    const { text, truncated } = await readCapped(response);
    if (truncated) {
      return {
        url,
        status: response.status,
        json: null,
        problem: `${url} returned more than 256 KiB, which doctor does not read`,
      };
    }
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return {
      url,
      status: response.status,
      json: response.ok && isRecord(json) ? json : null,
    };
  } catch (error) {
    return {
      url,
      status: 0,
      json: null,
      problem:
        error instanceof DoctorRequestError
          ? error.kind === "timeout"
            ? error.message
            : undefined
          : undefined,
    };
  }
}

function withoutTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function failure(fetched: Fetched): string {
  return (
    fetched.problem ??
    (fetched.status === 0 ? "no response" : `HTTP ${fetched.status}`)
  );
}

// ---------------------------------------------------------------------------
// Protected-resource metadata (RFC 9728), in the order MCP clients try it
// ---------------------------------------------------------------------------

export interface ProtectedResourceDiscovery {
  url?: string;
  status: number;
  metadata: Record<string, unknown> | null;
  /** How the metadata was found, or why it was not. */
  source: "the 401 challenge" | "the well-known location" | "none";
  tried: string[];
  problem?: string;
  /** Metadata exists only at {endpoint}/oauth-protected-resource. */
  suffixOnly?: string;
  insecure?: string;
}

function validResourceMetadata(
  metadata: Record<string, unknown> | null,
): boolean {
  return (
    typeof metadata?.resource === "string" &&
    Array.isArray(metadata.authorization_servers)
  );
}

export async function discoverProtectedResource(
  endpoint: URL,
  challengeUrl: string | undefined,
): Promise<ProtectedResourceDiscovery> {
  if (challengeUrl) {
    if (!acceptableUrl(challengeUrl)) {
      return {
        status: 0,
        metadata: null,
        source: "the 401 challenge",
        tried: [],
        insecure: challengeUrl,
      };
    }
    const fetched = await getJson(challengeUrl);
    return {
      url: challengeUrl,
      status: fetched.status,
      metadata: fetched.json,
      source: "the 401 challenge",
      tried: [challengeUrl],
      problem: fetched.problem,
    };
  }
  const base = new URL(endpoint.href);
  base.hash = "";
  base.search = "";
  const path = withoutTrailingSlash(base.pathname);
  const candidates = [
    ...new Set([
      `${base.origin}/.well-known/oauth-protected-resource${path}`,
      `${base.origin}/.well-known/oauth-protected-resource`,
    ]),
  ];
  let last: Fetched | undefined;
  for (const candidate of candidates) {
    const fetched = await getJson(candidate);
    last = fetched;
    if (validResourceMetadata(fetched.json)) {
      return {
        url: candidate,
        status: fetched.status,
        metadata: fetched.json,
        source: "the well-known location",
        tried: candidates,
      };
    }
  }
  const suffix = `${base.origin}${path}/oauth-protected-resource`;
  const suffixed = await getJson(suffix);
  return {
    status: last?.status ?? 0,
    metadata: null,
    source: "none",
    tried: candidates,
    problem: last?.problem,
    ...(validResourceMetadata(suffixed.json) ? { suffixOnly: suffix } : {}),
  };
}

export function protectedResourceChecks(
  endpoint: URL,
  discovery: ProtectedResourceDiscovery,
): DoctorCheck[] {
  const valid = validResourceMetadata(discovery.metadata);
  let detail: string;
  if (valid) {
    detail = `HTTP ${discovery.status}; served from ${discovery.source}: ${discovery.url}`;
  } else if (discovery.insecure) {
    detail = `The 401 challenge points at '${discovery.insecure}', which is not an https URL. Point resource_metadata at an https URL, then retry.`;
  } else if (discovery.suffixOnly) {
    detail = `Metadata exists at ${discovery.suffixOnly}, but the 401 challenge does not name it and clients do not look there. Add resource_metadata="${discovery.suffixOnly}" to the WWW-Authenticate header of the 401 response (Supabase's withOAuthProtectedResource does this), then retry.`;
  } else if (discovery.source === "the 401 challenge") {
    detail = `${discovery.problem ?? (discovery.status === 0 ? "no response" : `HTTP ${discovery.status}`)} at ${discovery.url}. The 401 challenge points at metadata that did not load. Serve RFC 9728 metadata there with a resource and authorization_servers, then retry.`;
  } else {
    detail = `${discovery.problem ?? (discovery.status === 0 ? "No response" : `HTTP ${discovery.status}`)}. The 401 challenge names no metadata URL, and none was found at ${discovery.tried.join(" or ")}. Add resource_metadata to the 401 challenge, or serve RFC 9728 metadata at the first location, then retry.`;
  }
  const checks: DoctorCheck[] = [
    { name: "protected-resource-metadata", ok: valid, detail },
  ];
  const expected = new URL(endpoint.href);
  expected.hash = "";
  expected.search = "";
  expected.pathname = expected.pathname.replace(/\/+$/, "");
  const resource = discovery.metadata?.resource;
  checks.push({
    name: "advertised-resource-url",
    ok:
      typeof resource === "string" &&
      resource.replace(/\/+$/, "") === expected.href.replace(/\/+$/, ""),
    detail:
      typeof resource === "string"
        ? resource
        : "protected-resource metadata did not advertise a resource URL",
  });
  return checks;
}

// ---------------------------------------------------------------------------
// Authorization server (RFC 8414), issuer, registration, signing keys
// ---------------------------------------------------------------------------

function firstAuthorizationServer(
  metadata: Record<string, unknown> | null,
): string | undefined {
  const servers = metadata?.authorization_servers;
  if (!Array.isArray(servers)) return undefined;
  return servers.find(
    (entry): entry is string => typeof entry === "string" && entry !== "",
  );
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value !== "";
}

type KeyKind = "asymmetric" | "secret" | "other";

function classify(key: unknown): KeyKind {
  if (!isRecord(key)) return "other";
  if (key.kty === "oct" || "k" in key) return "secret";
  if (key.kty === "EC") {
    return nonEmpty(key.crv) && nonEmpty(key.x) && nonEmpty(key.y)
      ? "asymmetric"
      : "other";
  }
  if (key.kty === "RSA") {
    return nonEmpty(key.n) && nonEmpty(key.e) ? "asymmetric" : "other";
  }
  if (key.kty === "OKP") {
    return nonEmpty(key.crv) && nonEmpty(key.x) ? "asymmetric" : "other";
  }
  return "other";
}

const ROTATE =
  "Supabase's MCP guide requires asymmetric (ES256 or RS256) signing keys, and legacy HS256 projects cannot use it. In the Supabase Dashboard, open Project Settings → JWT Keys and rotate to asymmetric JWT signing keys.";

/**
 * Runs the unauthenticated authorization-server checks for the first server
 * the protected resource advertises. Names stay stable for JSON consumers.
 */
export async function authorizationServerChecks(
  resourceMetadata: Record<string, unknown> | null,
): Promise<DoctorCheck[]> {
  const advertised = firstAuthorizationServer(resourceMetadata);
  if (!advertised) {
    return [
      {
        name: "authorization-server-metadata",
        ok: false,
        detail:
          "The protected-resource metadata lists no authorization server. Add the Supabase Auth URL (for example https://PROJECT_REF.supabase.co/auth/v1) to authorization_servers, then retry.",
      },
    ];
  }
  const issuerUrl = acceptableUrl(advertised);
  if (!issuerUrl) {
    return [
      {
        name: "authorization-server-metadata",
        ok: false,
        detail: `The advertised authorization server '${advertised}' is not an https URL. Advertise the full https URL of your Supabase Auth server.`,
      },
    ];
  }
  const loopback = isLoopbackHost(issuerUrl.hostname);
  const issuer = withoutTrailingSlash(issuerUrl.href);
  const issuerPath = withoutTrailingSlash(issuerUrl.pathname);
  const clientLocations =
    issuerPath === ""
      ? [
          `${issuerUrl.origin}/.well-known/oauth-authorization-server`,
          `${issuerUrl.origin}/.well-known/openid-configuration`,
        ]
      : [
          `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`,
          `${issuerUrl.origin}/.well-known/openid-configuration${issuerPath}`,
          `${issuer}/.well-known/openid-configuration`,
        ];
  let served: Fetched | undefined;
  let lastProblem: string | undefined;
  for (const candidate of clientLocations) {
    const fetched = await getJson(candidate);
    lastProblem = fetched.problem ?? lastProblem;
    if (fetched.json) {
      served = fetched;
      break;
    }
  }
  let nonClient = false;
  if (!served && issuerPath !== "") {
    const fetched = await getJson(
      `${issuer}/.well-known/oauth-authorization-server`,
    );
    if (fetched.json) {
      served = fetched;
      nonClient = true;
    }
  }
  if (!served?.json) {
    return [
      {
        name: "authorization-server-metadata",
        ok: false,
        detail: `${lastProblem ? `${lastProblem}. ` : ""}No authorization-server metadata at ${clientLocations.join(", ")}. In the Supabase Dashboard, open Authentication → OAuth Server and enable it, then retry.`,
      },
    ];
  }
  const metadata = served.json;
  const checks: DoctorCheck[] = [];
  if (!nonClient) {
    checks.push({
      name: "authorization-server-metadata",
      ok: true,
      detail: `HTTP ${served.status} from ${served.url}`,
    });
  } else {
    checks.push({
      name: "authorization-server-metadata",
      ok: false,
      detail: loopback
        ? `Found only at ${served.url}, which MCP clients do not read. The local Supabase CLI gateway serves metadata there; a hosted project should serve it at ${clientLocations[0]} or ${clientLocations[2]}.`
        : `Found only at ${served.url}, which MCP clients do not read, so they will stop at discovery. Serve the metadata at ${clientLocations[0]} (or ${clientLocations[2]}), then retry.`,
      ...(loopback ? { blocking: false } : {}),
    });
  }

  const reported =
    typeof metadata.issuer === "string" ? metadata.issuer : undefined;
  const matches = reported === advertised;
  checks.push({
    name: "issuer-match",
    ok: matches,
    detail: matches
      ? advertised
      : reported
        ? `The metadata issuer is '${reported}', but the protected resource advertises '${advertised}'. Clients compare these exactly, even a trailing slash, and stop at discovery on any difference. This is common with a Supabase custom domain. Advertise the issuer the metadata reports (for example authorizationServer: '${reported}'), then redeploy.`
        : `The authorization-server metadata has no issuer. Check the Auth server configuration, then retry.`,
  });

  const registration =
    typeof metadata.registration_endpoint === "string"
      ? metadata.registration_endpoint
      : undefined;
  const documents = metadata.client_id_metadata_document_supported === true;
  if (registration && !acceptableUrl(registration)) {
    checks.push({
      name: "client-registration",
      ok: false,
      detail: `registration_endpoint '${registration}' is not an https URL. Serve registration over https, then retry.`,
    });
  } else {
    checks.push({
      name: "client-registration",
      ok: Boolean(registration),
      detail: registration
        ? `registration_endpoint ${registration}${documents ? "; client ID metadata documents are also supported" : ""}`
        : `No registration_endpoint. Clients that register themselves (Claude, ChatGPT) cannot connect unless you register each client by hand.${documents ? " Clients that publish a client ID metadata document can still connect." : ""} Enable dynamic client registration under Authentication → OAuth Server, or register clients manually.`,
      blocking: false,
    });
  }

  const jwksUri =
    typeof metadata.jwks_uri === "string" ? metadata.jwks_uri : undefined;
  if (!jwksUri) {
    checks.push({
      name: "signing-keys",
      ok: false,
      detail:
        "The authorization-server metadata has no jwks_uri, so clients cannot find the signing keys. Check the Auth server configuration, then retry.",
    });
    return checks;
  }
  if (!acceptableUrl(jwksUri)) {
    checks.push({
      name: "signing-keys",
      ok: false,
      detail: `jwks_uri '${jwksUri}' is not an https URL, so doctor did not fetch it. Serve the key set over https, then retry.`,
    });
    return checks;
  }
  const jwks = await getJson(jwksUri);
  const keys = Array.isArray(jwks.json?.keys) ? jwks.json.keys : undefined;
  if (!keys) {
    checks.push({
      name: "signing-keys",
      ok: false,
      detail: `${failure(jwks)} at ${jwksUri}. The key set did not load. Check that the Auth server publishes its JWKS, then retry.`,
    });
    return checks;
  }
  if (keys.some((key) => classify(key) === "secret")) {
    checks.push({
      name: "signing-keys",
      ok: false,
      detail: `The public key set at ${jwksUri} contains a secret key (kty oct or a k member). A published signing secret lets anyone forge tokens. Rotate the signing key now: ${ROTATE}`,
    });
    return checks;
  }
  const strong = keys.filter((key) => classify(key) === "asymmetric");
  if (strong.length === 0) {
    checks.push({
      name: "signing-keys",
      ok: false,
      detail: `${keys.length === 0 ? "The key set is empty" : "The key set has no usable asymmetric key"}. ${ROTATE}`,
      ...(loopback ? { blocking: false } : {}),
    });
    return checks;
  }
  const algorithms = [
    ...new Set(
      strong.map((key) => {
        const record = key as Record<string, unknown>;
        return typeof record.alg === "string" ? record.alg : String(record.kty);
      }),
    ),
  ];
  checks.push({
    name: "signing-keys",
    ok: true,
    detail: `${strong.length} asymmetric key${strong.length === 1 ? "" : "s"} (${algorithms.join(", ")}) at ${jwksUri}`,
  });
  return checks;
}
