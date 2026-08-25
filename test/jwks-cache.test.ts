import { afterEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { defaultRuntimeDependencies } from "../src/runtime.js";

async function signedUserToken(kid: string) {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    email: "person@example.com",
    phone: "",
    role: "authenticated",
    aal: "aal1",
    amr: [],
    session_id: crypto.randomUUID(),
    is_anonymous: false,
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: {},
  })
    .setProtectedHeader({ alg: "ES256", kid, typ: "JWT" })
    .setIssuer("https://project.supabase.co/auth/v1")
    .setAudience("authenticated")
    .setSubject(crypto.randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
  return { token, jwks: { keys: [{ ...jwk, alg: "ES256", kid, use: "sig" }] } };
}

describe("remote JWKS verification", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches one bounded JWKS snapshot and reuses it across requests", async () => {
    const fixture = await signedUserToken("cache-proof");
    const fetchJwks = vi.fn(async () => Response.json(fixture.jwks));
    vi.stubGlobal("fetch", fetchJwks);
    const env = {
      url: "https://project.supabase.co",
      jwks: new URL(
        `https://project.supabase.co/auth/v1/.well-known/jwks.json?case=${crypto.randomUUID()}`,
      ),
    };

    const first = await defaultRuntimeDependencies.verifyToken(
      fixture.token,
      env,
    );
    const second = await defaultRuntimeDependencies.verifyToken(
      fixture.token,
      env,
    );

    expect(first.userClaims.id).toBe(first.jwtClaims.sub);
    expect(second.userClaims.id).toBe(first.userClaims.id);
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  it("does not retain a failed JWKS fetch", async () => {
    const fixture = await signedUserToken("retry-proof");
    const fetchJwks = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json(fixture.jwks));
    vi.stubGlobal("fetch", fetchJwks);
    const env = {
      url: "https://project.supabase.co",
      jwks: new URL(
        `https://project.supabase.co/auth/v1/.well-known/jwks.json?case=${crypto.randomUUID()}`,
      ),
    };

    await expect(
      defaultRuntimeDependencies.verifyToken(fixture.token, env),
    ).rejects.toThrow("JWKS endpoint returned HTTP 503");
    await expect(
      defaultRuntimeDependencies.verifyToken(fixture.token, env),
    ).resolves.toMatchObject({ userClaims: { email: "person@example.com" } });
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });
});
