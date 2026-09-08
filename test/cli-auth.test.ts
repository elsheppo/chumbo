import { describe, expect, it } from "vitest";
import type { StoredOAuthTokens } from "@modelcontextprotocol/client";
import {
  KeychainOAuthProvider,
  type SecureCredentialStore,
} from "../src/cli-host.js";

class MemoryStore implements SecureCredentialStore {
  readonly values = new Map<string, string>();

  async get(account: string): Promise<string | undefined> {
    return this.values.get(account);
  }

  async set(account: string, value: string): Promise<void> {
    this.values.set(account, value);
  }

  async delete(account: string): Promise<boolean> {
    return this.values.delete(account);
  }
}

function provider(store: SecureCredentialStore, endpoint: string) {
  return new KeychainOAuthProvider({
    endpoint,
    redirectUrl: "http://127.0.0.1:43123/oauth/callback",
    displayName: "Acme Ops",
    version: "1.0.0",
    store,
    openAuthorization() {},
  });
}

describe("client CLI credential partitioning", () => {
  it("binds tokens to endpoint and authorization-server issuer", async () => {
    const store = new MemoryStore();
    const first = provider(store, "https://api.acme.example/mcp");
    const second = provider(store, "https://api.other.example/mcp");
    const tokens = {
      access_token: "secret-access-token",
      token_type: "Bearer",
      refresh_token: "secret-refresh-token",
      issuer: "https://project.supabase.co/auth/v1",
    } as StoredOAuthTokens;

    await first.saveTokens(tokens, {
      issuer: "https://project.supabase.co/auth/v1",
    });

    await expect(first.tokens()).resolves.toEqual(tokens);
    await expect(
      first.tokens({ issuer: "https://project.supabase.co/auth/v1" }),
    ).resolves.toEqual(tokens);
    await expect(second.tokens()).resolves.toBeUndefined();
    expect([...store.values.keys()].join(" ")).not.toContain("supabase.co");
    expect([...store.values.keys()].join(" ")).not.toContain("api.acme");
  });

  it("keeps PKCE state durable and invalidates only the requested credential class", async () => {
    const store = new MemoryStore();
    const auth = provider(store, "https://api.acme.example/mcp");
    const state = await auth.state();
    await auth.saveCodeVerifier("verifier");
    await auth.saveTokens(
      {
        access_token: "access",
        token_type: "Bearer",
        issuer: "https://issuer.example",
      } as StoredOAuthTokens,
      { issuer: "https://issuer.example" },
    );

    await expect(auth.expectedState()).resolves.toBe(state);
    await expect(auth.codeVerifier()).resolves.toBe("verifier");
    await auth.invalidateCredentials("tokens");
    await expect(auth.tokens()).resolves.toBeUndefined();
    await expect(auth.codeVerifier()).resolves.toBe("verifier");
    await auth.invalidateCredentials("all");
    await expect(auth.expectedState()).resolves.toBeUndefined();
  });
});
