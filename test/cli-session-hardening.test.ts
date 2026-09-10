import { describe, expect, it } from "vitest";
import {
  UnauthorizedError,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import {
  KeychainOAuthProvider,
  createBrandedCli,
  type BrandedCliConnector,
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

describe("client CLI session hardening", () => {
  it("removes every issuer partition previously bound to the package endpoint", async () => {
    const store = new MemoryStore();
    const auth = new KeychainOAuthProvider({
      endpoint: "https://api.acme.example/mcp",
      redirectUrl: "http://127.0.0.1:47832/oauth/callback",
      displayName: "Acme Ops",
      version: "1.0.0",
      store,
      openAuthorization() {},
    });
    for (const issuer of ["https://issuer.one", "https://issuer.two"]) {
      await auth.saveTokens(
        {
          access_token: issuer,
          token_type: "Bearer",
          issuer,
        } as StoredOAuthTokens,
        { issuer },
      );
    }
    expect(store.values.size).toBe(3);

    await auth.invalidateCredentials("all");

    expect(store.values.size).toBe(0);
  });

  it("checks the live MCP session instead of trusting token presence", async () => {
    const output: string[] = [];
    const connector: BrandedCliConnector = {
      async connect() {
        throw new UnauthorizedError();
      },
      async loggedInIssuer() {
        return "https://issuer.example";
      },
      async logout() {},
    };
    const cli = createBrandedCli(
      {
        packageName: "@acme/ops-cli",
        binaryName: "acme",
        displayName: "Acme Ops",
        version: "1.0.0",
        endpoint: "https://api.acme.example/mcp",
      },
      {
        connector,
        io: {
          stdout(value) {
            output.push(value);
          },
          stderr(value) {
            output.push(value);
          },
          isTTY: false,
          async confirm() {
            return false;
          },
        },
      },
    );

    await expect(cli.run(["status"])).resolves.toBe(3);
    expect(output).toEqual(["Session expired. Run 'acme login'."]);
  });
});
