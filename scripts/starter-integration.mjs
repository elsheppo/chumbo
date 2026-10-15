// Integration verification for every starter (starters/SPEC.md §6, steps 5–6).
// For each starter this creates the app with the packed CLI, starts its own
// local Supabase stack, runs the shipped RLS isolation test, then drives the
// complete MCP OAuth flow through a real browser and the web app's consent
// page. Needs Docker, the Supabase CLI, Deno, and a Chromium/Chrome binary
// (CHROMIUM_PATH, /opt/pw-browsers/chromium, or Playwright's `chrome` channel).
//
//   node scripts/starter-integration.mjs [starter...] [--keep] [--screenshots <dir>]
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import {
  createFromPackage,
  packChumbo,
  run,
  useLocalRuntime,
} from "./starter-lib.mjs";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const screenshotIndex = args.indexOf("--screenshots");
const screenshots =
  screenshotIndex >= 0 ? resolve(args[screenshotIndex + 1]) : undefined;
const selected = args.filter(
  (arg, index) => !arg.startsWith("--") && index !== screenshotIndex + 1,
);

const FUNCTION_PORT = 8000;
const CALLBACK = "http://127.0.0.1:8976/callback";
// Only what Auth, PostgREST, and the OAuth server need.
const EXCLUDED_SERVICES =
  "studio,imgproxy,vector,logflare,supavisor,storage-api,realtime,mailpit,postgres-meta,edge-runtime";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const children = [];
function stopGroup(child) {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already exited.
  }
}
function background(command, commandArgs, options) {
  // Own process group, so stopping it also stops grandchildren (npm -> vite).
  const child = spawn(command, commandArgs, {
    ...options,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...options.env },
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  children.push(child);
  return { stop: () => stopGroup(child), output: () => output };
}

async function waitFor(label, check, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(
    `Timed out waiting for ${label}: ${lastError?.message ?? ""}`,
  );
}

function launchOptions() {
  const path =
    process.env.CHROMIUM_PATH ??
    (existsSync("/opt/pw-browsers/chromium")
      ? "/opt/pw-browsers/chromium"
      : undefined);
  return path ? { executablePath: path } : { channel: "chrome" };
}

function base64url(buffer) {
  return buffer.toString("base64url");
}

async function mcp(url, method, params, token) {
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-method": method,
    "mcp-protocol-version": "2026-07-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (params?.name) headers["mcp-name"] = params.name;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomBytes(4).toString("hex"),
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "starter-e2e",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  return response;
}

/** Discovers, registers, and authorizes exactly as a remote MCP client does. */
async function connectAsUser({ browser, mcpUrl, user, screenshotPrefix }) {
  const challenge = await mcp(mcpUrl, "tools/list", {});
  assert(
    challenge.status === 401,
    `expected 401 challenge, received ${challenge.status}`,
  );
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(
    challenge.headers.get("www-authenticate") ?? "",
  )?.[1];
  assert(metadataUrl, "challenge names the protected resource metadata");
  const resource = await (await fetch(metadataUrl)).json();
  const issuer = resource.authorization_servers?.[0];
  assert(
    issuer,
    `resource metadata names an authorization server: ${JSON.stringify(resource)}`,
  );
  const issuerUrl = new URL(issuer);
  const candidates = [
    `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname}`,
    `${issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
  ];
  let server;
  for (const candidate of candidates) {
    const response = await fetch(candidate);
    if (response.ok) {
      server = await response.json();
      break;
    }
  }
  assert(
    server?.registration_endpoint,
    "authorization server supports registration",
  );

  const registration = await fetch(server.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Starter E2E Agent",
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  const client = await registration.json();
  assert(
    registration.ok && client.client_id,
    `registration failed: ${JSON.stringify(client)}`,
  );

  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(16));
  const authorize = new URL(server.authorization_endpoint);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: CALLBACK,
    code_challenge: base64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    state,
    resource: resource.resource ?? mcpUrl,
  }).toString();

  const context = await browser.newContext();
  const page = await context.newPage();
  let redirected;
  await page.route(`${CALLBACK}**`, async (route) => {
    redirected = new URL(route.request().url());
    await route.fulfill({
      contentType: "text/plain",
      body: "Authorized. Return to your agent.",
    });
  });
  await page.goto(authorize.href);
  await page.waitForURL(/\/oauth\/consent\?authorization_id=/);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Approve" }).waitFor();
  const consentText = await page.getByLabel("Connection request").innerText();
  assert(consentText.includes("Starter E2E Agent"), "consent names the client");
  assert(consentText.includes(user.email), "consent names the signed-in user");
  if (screenshotPrefix) {
    await page.screenshot({ path: `${screenshotPrefix}-consent.png` });
  }
  await page.getByRole("button", { name: "Approve" }).click();
  await waitFor("OAuth redirect", () => redirected !== undefined, 15_000);
  await context.close();

  assert(redirected.searchParams.get("state") === state, "state round-trips");
  const code = redirected.searchParams.get("code");
  assert(code, `redirect carries a code: ${redirected}`);
  const tokenResponse = await fetch(server.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: resource.resource ?? mcpUrl,
    }),
  });
  const tokens = await tokenResponse.json();
  assert(
    tokenResponse.ok && tokens.access_token,
    `token exchange: ${JSON.stringify(tokens)}`,
  );
  return tokens.access_token;
}

async function callTool(mcpUrl, token, name, toolArgs = {}) {
  const response = await mcp(
    mcpUrl,
    "tools/call",
    { name, arguments: toolArgs },
    token,
  );
  const body = await response.json();
  assert(
    response.ok && !body.error && !body.result?.isError,
    `${name}: ${JSON.stringify(body)}`,
  );
  return body.result;
}

const fixture = await mkdtemp(join(tmpdir(), "chumbo-starter-it-"));
if (screenshots) await mkdir(screenshots, { recursive: true });
let browser;

try {
  const packageRoot = await packChumbo(fixture);
  const catalog = JSON.parse(
    run(process.execPath, [
      join(packageRoot, "dist", "cli.js"),
      "create",
      "--list",
      "--json",
    ]),
  );
  const starters = catalog.starters.filter(
    ({ id }) => selected.length === 0 || selected.includes(id),
  );
  assert(starters.length > 0, `No starters match ${selected.join(", ")}`);
  browser = await chromium.launch(launchOptions());

  for (const starter of starters) {
    const label = `[${starter.id}]`;
    const app = join(fixture, `${starter.id}-it`);
    createFromPackage(packageRoot, starter.id, app);
    await useLocalRuntime(app, packageRoot, starter.function);

    console.log(`${label} starting local Supabase…`);
    run("supabase", ["start", "-x", EXCLUDED_SERVICES], {
      cwd: app,
      stdio: "inherit",
    });
    try {
      const status = JSON.parse(
        run("supabase", ["status", "--output", "json"], { cwd: app }),
      );
      const apiUrl = status.API_URL;
      const publishableKey = status.PUBLISHABLE_KEY ?? status.ANON_KEY;

      // Step 5: the RLS isolation test the starter ships to builders.
      run(
        "deno",
        [
          "test",
          "--config",
          join("supabase", "functions", starter.function, "deno.json"),
          "--allow-env",
          "--allow-net",
          join("supabase", "tests"),
        ],
        {
          cwd: app,
          stdio: "inherit",
          env: {
            SUPABASE_URL: apiUrl,
            SUPABASE_PUBLISHABLE_KEY: publishableKey,
          },
        },
      );
      console.log(`${label} RLS isolation holds through MCP`);

      // Step 6: serve the function and the web app, then connect like a client.
      const jwks = await (
        await fetch(`${apiUrl}/auth/v1/.well-known/jwks.json`)
      ).text();
      const mcpUrl = `http://127.0.0.1:${FUNCTION_PORT}/functions/v1/${starter.function}`;
      const fn = background(
        "deno",
        ["run", "--allow-env", "--allow-net", "--allow-read", "index.ts"],
        {
          cwd: join(app, "supabase", "functions", starter.function),
          env: {
            SUPABASE_URL: apiUrl,
            SUPABASE_PUBLISHABLE_KEY: publishableKey,
            SUPABASE_JWKS: jwks,
            MCP_PUBLIC_URL: mcpUrl,
          },
        },
      );
      await waitFor("the MCP function", async () =>
        [401].includes((await mcp(mcpUrl, "tools/list", {})).status),
      ).catch((error) => {
        throw new Error(`${error.message}\n${fn.output()}`);
      });

      const web = join(app, "web");
      run("npm", ["install", "--no-audit", "--no-fund"], { cwd: web });
      await writeFile(
        join(web, ".env.local"),
        `VITE_SUPABASE_URL=${apiUrl}\nVITE_SUPABASE_PUBLISHABLE_KEY=${publishableKey}\nVITE_MCP_URL=${mcpUrl}\n`,
      );
      const vite = background("npm", ["run", "dev"], { cwd: web });
      await waitFor(
        "the web app",
        async () => (await fetch("http://127.0.0.1:5173/")).ok,
      ).catch((error) => {
        throw new Error(`${error.message}\n${vite.output()}`);
      });

      const [alice, bob] = starter.demoUsers;
      const prefix = screenshots ? join(screenshots, starter.id) : undefined;
      const aliceToken = await connectAsUser({
        browser,
        mcpUrl,
        user: alice,
        screenshotPrefix: prefix,
      });
      const bobToken = await connectAsUser({ browser, mcpUrl, user: bob });
      console.log(
        `${label} OAuth discovery, registration, consent, and PKCE exchange succeeded`,
      );

      const tools = await (
        await mcp(mcpUrl, "tools/list", {}, aliceToken)
      ).json();
      const toolNames = tools.result.tools.map(({ name }) => name).sort();
      assert(
        JSON.stringify(toolNames) === JSON.stringify([...starter.tools].sort()),
        `${label} tools: ${toolNames.join(", ")}`,
      );

      if (starter.id === "team-tasks") {
        const teamsOf = async (token) =>
          [
            ...new Set(
              (
                await callTool(mcpUrl, token, "list_tasks", { limit: 100 })
              ).structuredContent.items.map(({ team }) => team),
            ),
          ].sort();
        const aliceTeams = await teamsOf(aliceToken);
        const bobTeams = await teamsOf(bobToken);
        assert(
          JSON.stringify(aliceTeams) ===
            JSON.stringify(["Alice's Studio", "Launch Crew"]),
          `Alice's OAuth token sees ${aliceTeams}`,
        );
        assert(
          JSON.stringify(bobTeams) ===
            JSON.stringify(["Bob's Garage", "Launch Crew"]),
          `Bob's OAuth token sees ${bobTeams}`,
        );

        // The agent's write appears in the web app for the same user.
        const title = `Created by an agent ${randomBytes(3).toString("hex")}`;
        const [crew] = (
          await callTool(mcpUrl, aliceToken, "list_teams")
        ).structuredContent.teams.filter(({ name }) => name === "Launch Crew");
        await callTool(mcpUrl, aliceToken, "create_task", {
          team_id: crew.id,
          title,
        });
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto("http://127.0.0.1:5173/");
        await page.getByLabel("Email").fill(bob.email);
        await page.getByLabel("Password").fill(bob.password);
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.getByRole("button", { name: "Launch Crew" }).click();
        await page.getByText(title).waitFor();
        assert(
          (await page.getByText("Alice's Studio").count()) === 0,
          "Bob's web view does not show Alice's private team",
        );
        if (prefix)
          await page.screenshot({
            path: `${prefix}-workspace.png`,
            fullPage: true,
          });
        await context.close();
        console.log(
          `${label} each OAuth identity sees only its RLS slice; agent writes reach the app`,
        );
      }
      fn.stop();
      vite.stop();
    } finally {
      if (!keep)
        run("supabase", ["stop", "--no-backup"], {
          cwd: app,
          stdio: "inherit",
        });
    }
  }
  console.log(`Integration verified for ${starters.length} starter(s).`);
} finally {
  await browser?.close();
  for (const child of children) stopGroup(child);
  if (!keep) {
    await rm(fixture, { recursive: true, force: true, maxRetries: 5 }).catch(
      (error) => console.error(`Could not remove ${fixture}: ${error.message}`),
    );
  } else console.log(`Kept ${fixture}`);
}
