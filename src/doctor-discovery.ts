import type { DoctorCheck } from "./doctor.js";

interface Fetched {
  url: string;
  status: number;
  json: Record<string, unknown> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** GET only. Discovery never registers a client or writes anything. */
async function getJson(url: string): Promise<Fetched> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    const json = (await response.json().catch(() => null)) as unknown;
    return {
      url,
      status: response.status,
      json: response.ok && isRecord(json) ? json : null,
    };
  } catch {
    return { url, status: 0, json: null };
  }
}

function withoutTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function statusText(status: number): string {
  return status === 0 ? "no response" : `HTTP ${status}`;
}

// ---------------------------------------------------------------------------
// Protected-resource metadata (RFC 9728)
// ---------------------------------------------------------------------------

export interface ProtectedResourceDiscovery {
  url: string;
  status: number;
  metadata: Record<string, unknown> | null;
  source: "the 401 challenge" | "the well-known location";
  tried: string[];
}

function validResourceMetadata(
  metadata: Record<string, unknown> | null,
): boolean {
  return (
    typeof metadata?.resource === "string" &&
    Array.isArray(metadata.authorization_servers)
  );
}

/**
 * Follows the challenge's resource_metadata URL when present. Otherwise tries
 * the RFC 9728 well-known location, then the `{resource}/oauth-protected-resource`
 * suffix that Supabase's official helper serves.
 */
export async function discoverProtectedResource(
  endpoint: URL,
  challengeUrl: string | undefined,
): Promise<ProtectedResourceDiscovery> {
  if (challengeUrl) {
    const fetched = await getJson(challengeUrl);
    return {
      url: challengeUrl,
      status: fetched.status,
      metadata: fetched.json,
      source: "the 401 challenge",
      tried: [challengeUrl],
    };
  }
  const base = new URL(endpoint.href);
  base.hash = "";
  base.search = "";
  const path = withoutTrailingSlash(base.pathname);
  const candidates = [
    `${base.origin}/.well-known/oauth-protected-resource${path}`,
    `${base.origin}${path}/oauth-protected-resource`,
  ];
  let last: Fetched | undefined;
  for (const candidate of candidates) {
    const fetched = await getJson(candidate);
    last ??= fetched;
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
  return {
    url: candidates[0]!,
    status: last?.status ?? 0,
    metadata: null,
    source: "the well-known location",
    tried: candidates,
  };
}

export function protectedResourceChecks(
  endpoint: URL,
  discovery: ProtectedResourceDiscovery,
): DoctorCheck[] {
  const valid = validResourceMetadata(discovery.metadata);
  const checks: DoctorCheck[] = [
    {
      name: "protected-resource-metadata",
      ok: valid,
      detail: valid
        ? `HTTP ${discovery.status}; served from ${discovery.source}: ${discovery.url}`
        : discovery.source === "the 401 challenge"
          ? `${statusText(discovery.status)} at ${discovery.url}. The 401 challenge points at metadata that did not load. Serve RFC 9728 metadata there with a resource and authorization_servers, then retry.`
          : `${statusText(discovery.status)}. The 401 challenge names no metadata URL, and none was found at ${discovery.tried.join(" or ")}. Serve RFC 9728 metadata with a resource and authorization_servers, then retry.`,
    },
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

function asymmetric(key: unknown): boolean {
  if (!isRecord(key)) return false;
  return (
    key.kty === "EC" ||
    key.kty === "RSA" ||
    key.alg === "ES256" ||
    key.alg === "RS256"
  );
}

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
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(advertised);
  } catch {
    return [
      {
        name: "authorization-server-metadata",
        ok: false,
        detail: `The advertised authorization server '${advertised}' is not a valid URL. Advertise the full https URL of your Supabase Auth server.`,
      },
    ];
  }
  const issuer = withoutTrailingSlash(issuerUrl.href);
  const issuerPath = withoutTrailingSlash(issuerUrl.pathname);
  const candidates = [
    ...new Set([
      `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`,
      `${issuer}/.well-known/oauth-authorization-server`,
      `${issuer}/.well-known/openid-configuration`,
    ]),
  ];
  let served: Fetched | undefined;
  for (const candidate of candidates) {
    const fetched = await getJson(candidate);
    if (fetched.json) {
      served = fetched;
      break;
    }
  }
  if (!served?.json) {
    return [
      {
        name: "authorization-server-metadata",
        ok: false,
        detail: `No authorization-server metadata at ${candidates.join(", ")}. In the Supabase Dashboard, open Authentication → OAuth Server and enable it, then retry.`,
      },
    ];
  }
  const metadata = served.json;
  const checks: DoctorCheck[] = [
    {
      name: "authorization-server-metadata",
      ok: true,
      detail: `HTTP ${served.status} from ${served.url}`,
    },
  ];

  const reported =
    typeof metadata.issuer === "string"
      ? withoutTrailingSlash(metadata.issuer)
      : undefined;
  const matches = reported === issuer;
  checks.push({
    name: "issuer-match",
    ok: matches,
    detail: matches
      ? issuer
      : reported
        ? `The metadata issuer is '${reported}', but the protected resource advertises '${issuer}'. Clients compare these exactly and stop at discovery. This is common with a Supabase custom domain. Advertise the issuer the metadata reports (for example authorizationServer: '${reported}'), then redeploy.`
        : `The authorization-server metadata has no issuer. Check the Auth server configuration, then retry.`,
  });

  const registration =
    typeof metadata.registration_endpoint === "string"
      ? metadata.registration_endpoint
      : undefined;
  const documents = metadata.client_id_metadata_document_supported === true;
  checks.push({
    name: "client-registration",
    ok: Boolean(registration),
    detail: registration
      ? `registration_endpoint ${registration}${documents ? "; client ID metadata documents are also supported" : ""}`
      : `No registration_endpoint. Clients that register themselves (Claude, ChatGPT) cannot connect unless you register each client by hand.${documents ? " Clients that publish a client ID metadata document can still connect." : ""} Enable dynamic client registration under Authentication → OAuth Server, or register clients manually.`,
    blocking: false,
  });

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
  const jwks = await getJson(jwksUri);
  const keys = Array.isArray(jwks.json?.keys) ? jwks.json.keys : undefined;
  if (!keys) {
    checks.push({
      name: "signing-keys",
      ok: false,
      detail: `${statusText(jwks.status)} at ${jwksUri}. The key set did not load. Check that the Auth server publishes its JWKS, then retry.`,
    });
    return checks;
  }
  const strong = keys.filter(asymmetric);
  if (strong.length === 0) {
    checks.push({
      name: "signing-keys",
      ok: false,
      detail: `${keys.length === 0 ? "The key set is empty" : `The key set has only symmetric keys (${keys.length})`}. This looks like a legacy HS256 project, and Supabase's official helpers reject its tokens. In the Supabase Dashboard, open Project Settings → JWT Keys and rotate to asymmetric signing keys (ES256 or RS256).`,
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
