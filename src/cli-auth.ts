import { createHash, randomBytes } from "node:crypto";
import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";

export interface SecureCredentialStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<boolean>;
}

interface KeyringEntry {
  getPassword(): Promise<string | undefined>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

interface KeyringModule {
  AsyncEntry: new (service: string, account: string) => KeyringEntry;
}

let keyringModulePromise: Promise<KeyringModule> | undefined;

async function loadKeyringEntry(
  service: string,
  account: string,
): Promise<KeyringEntry> {
  if (!keyringModulePromise) {
    keyringModulePromise = (
      import("@napi-rs/keyring") as Promise<KeyringModule>
    ).catch((error: unknown) => {
      keyringModulePromise = undefined;
      throw error;
    });
  }
  const { AsyncEntry } = await keyringModulePromise;
  return new AsyncEntry(service, account);
}

export class SystemCredentialStore implements SecureCredentialStore {
  constructor(private readonly service: string) {}

  async get(account: string): Promise<string | undefined> {
    const entry = await loadKeyringEntry(this.service, account);
    return entry.getPassword();
  }

  async set(account: string, value: string): Promise<void> {
    const entry = await loadKeyringEntry(this.service, account);
    await entry.setPassword(value);
  }

  async delete(account: string): Promise<boolean> {
    const entry = await loadKeyringEntry(this.service, account);
    return entry.deleteCredential();
  }
}

interface EndpointState {
  currentIssuer?: string;
  issuers?: string[];
  codeVerifier?: string;
  oauthState?: string;
  discovery?: OAuthDiscoveryState;
  authorizationServerUrl?: string;
  resourceUrl?: string;
}

interface IssuerState {
  clientInformation?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
}

interface StaticTokenState {
  token?: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseState<T extends object>(value: string | undefined): T {
  if (!value) return {} as T;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("not an object");
    }
    return parsed as T;
  } catch {
    throw new Error("The secure credential store contains invalid CLI state");
  }
}

function stampedIssuer(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const issuer = (value as { issuer?: unknown }).issuer;
  return typeof issuer === "string" && issuer ? issuer : undefined;
}

/** Endpoint-partitioned static bearer/API-key credential stored in the OS keychain. */
export class StaticTokenCredentialStore {
  private readonly account: string;

  constructor(
    private readonly store: SecureCredentialStore,
    endpoint: string,
  ) {
    this.account = `token:${digest(new URL(endpoint).href)}`;
  }

  async get(): Promise<string | undefined> {
    const state = parseState<StaticTokenState>(
      await this.store.get(this.account),
    );
    return typeof state.token === "string" && state.token.length > 0
      ? state.token
      : undefined;
  }

  async set(token: string): Promise<void> {
    await this.store.set(this.account, JSON.stringify({ token }));
  }

  async delete(): Promise<boolean> {
    return this.store.delete(this.account);
  }
}

export interface KeychainOAuthProviderOptions {
  readonly endpoint: string;
  readonly redirectUrl: string;
  readonly displayName: string;
  readonly version: string;
  readonly store: SecureCredentialStore;
  readonly openAuthorization: (url: URL) => void | Promise<void>;
}

/** OAuth provider whose durable values live only in the OS credential store. */
export class KeychainOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;
  private readonly endpointAccount: string;

  constructor(private readonly options: KeychainOAuthProviderOptions) {
    this.redirectUrl = options.redirectUrl;
    this.endpointAccount = `endpoint:${digest(options.endpoint)}`;
    this.clientMetadata = {
      client_name: `${options.displayName} CLI`,
      client_uri: new URL(options.endpoint).origin,
      redirect_uris: [options.redirectUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      software_id: `dev.chumbo.branded-cli:${options.displayName}`,
      software_version: options.version,
    };
  }

  private issuerAccount(issuer: string): string {
    return `issuer:${digest(issuer)}`;
  }

  private async endpointState(): Promise<EndpointState> {
    return parseState<EndpointState>(
      await this.options.store.get(this.endpointAccount),
    );
  }

  private async saveEndpoint(next: EndpointState): Promise<void> {
    await this.options.store.set(this.endpointAccount, JSON.stringify(next));
  }

  private async issuerState(issuer: string): Promise<IssuerState> {
    return parseState<IssuerState>(
      await this.options.store.get(this.issuerAccount(issuer)),
    );
  }

  private async saveIssuer(issuer: string, next: IssuerState): Promise<void> {
    await this.options.store.set(
      this.issuerAccount(issuer),
      JSON.stringify(next),
    );
  }

  private async bindIssuer(issuer: string): Promise<void> {
    const endpoint = await this.endpointState();
    await this.saveEndpoint({
      ...endpoint,
      currentIssuer: issuer,
      issuers: [...new Set([...(endpoint.issuers ?? []), issuer])],
    });
  }

  private async issuer(
    context?: OAuthClientInformationContext,
    value?: unknown,
  ): Promise<string | undefined> {
    return (
      context?.issuer ??
      stampedIssuer(value) ??
      (await this.endpointState()).currentIssuer
    );
  }

  async state(): Promise<string> {
    const value = randomBytes(32).toString("base64url");
    await this.saveEndpoint({
      ...(await this.endpointState()),
      oauthState: value,
    });
    return value;
  }

  async expectedState(): Promise<string | undefined> {
    return (await this.endpointState()).oauthState;
  }

  async clientInformation(
    context?: OAuthClientInformationContext,
  ): Promise<StoredOAuthClientInformation | undefined> {
    const issuer = await this.issuer(context);
    return issuer
      ? (await this.issuerState(issuer)).clientInformation
      : undefined;
  }

  async saveClientInformation(
    value: StoredOAuthClientInformation,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    const issuer = await this.issuer(context, value);
    if (!issuer)
      throw new Error("OAuth client information has no issuer binding");
    await this.saveIssuer(issuer, {
      ...(await this.issuerState(issuer)),
      clientInformation: value,
    });
    await this.bindIssuer(issuer);
  }

  async tokens(
    context?: OAuthClientInformationContext,
  ): Promise<StoredOAuthTokens | undefined> {
    const issuer = await this.issuer(context);
    return issuer ? (await this.issuerState(issuer)).tokens : undefined;
  }

  async saveTokens(
    value: StoredOAuthTokens,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    const issuer = await this.issuer(context, value);
    if (!issuer) throw new Error("OAuth tokens have no issuer binding");
    await this.saveIssuer(issuer, {
      ...(await this.issuerState(issuer)),
      tokens: value,
    });
    await this.bindIssuer(issuer);
  }

  redirectToAuthorization(url: URL): void | Promise<void> {
    return this.options.openAuthorization(url);
  }

  async saveCodeVerifier(value: string): Promise<void> {
    await this.saveEndpoint({
      ...(await this.endpointState()),
      codeVerifier: value,
    });
  }

  async codeVerifier(): Promise<string> {
    const value = (await this.endpointState()).codeVerifier;
    if (!value)
      throw new Error("OAuth code verifier is missing; restart login");
    return value;
  }

  async saveAuthorizationServerUrl(value: string): Promise<void> {
    await this.saveEndpoint({
      ...(await this.endpointState()),
      authorizationServerUrl: value,
    });
  }

  async authorizationServerUrl(): Promise<string | undefined> {
    return (await this.endpointState()).authorizationServerUrl;
  }

  async saveResourceUrl(value: string): Promise<void> {
    await this.saveEndpoint({
      ...(await this.endpointState()),
      resourceUrl: value,
    });
  }

  async resourceUrl(): Promise<string | undefined> {
    return (await this.endpointState()).resourceUrl;
  }

  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    await this.saveEndpoint({
      ...(await this.endpointState()),
      discovery: value,
    });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.endpointState()).discovery;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    const endpoint = await this.endpointState();
    const issuer = endpoint.currentIssuer;
    if (scope === "all") {
      const issuers = new Set(endpoint.issuers ?? []);
      if (issuer) issuers.add(issuer);
      await Promise.all(
        [...issuers].map((item) =>
          this.options.store.delete(this.issuerAccount(item)),
        ),
      );
      await this.options.store.delete(this.endpointAccount);
      return;
    }
    if (scope === "verifier") {
      delete endpoint.codeVerifier;
      delete endpoint.oauthState;
      await this.saveEndpoint(endpoint);
      return;
    }
    if (scope === "discovery") {
      delete endpoint.discovery;
      await this.saveEndpoint(endpoint);
      return;
    }
    if (!issuer) return;
    const state = await this.issuerState(issuer);
    if (scope === "tokens") delete state.tokens;
    if (scope === "client") delete state.clientInformation;
    await this.saveIssuer(issuer, state);
  }

  async loggedInIssuer(): Promise<string | undefined> {
    const issuer = (await this.endpointState()).currentIssuer;
    if (!issuer) return undefined;
    return (await this.issuerState(issuer)).tokens ? issuer : undefined;
  }
}
