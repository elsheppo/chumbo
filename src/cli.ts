#!/usr/bin/env node
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { runDoctor } from "./doctor.js";
import {
  applyPlan,
  displayPlan,
  findSupabaseProject,
  planInit,
} from "./project.js";

const HELP = `create-supabase-mcp 0.2.0

Usage:
  create-supabase-mcp init [options]
  create-supabase-mcp doctor [options]
  create-supabase-mcp dev [options]

Options:
  --function <name>       Edge Function name (default: mcp)
  --server-name <name>    MCP display name (default: repository name)
  --auth <mode>           oauth, bearer, or public (default: oauth)
  --consent <mode>        none or minimal (default: none)
  --url <url>             Deployed MCP URL for doctor
  --token <jwt>           User access token for doctor's tools/list probe
  --dry-run               Print init's file plan without writing
  --yes                   Accept init's file plan without prompting
  --no-config             Do not patch supabase/config.toml
  --help                  Show this help
`;

function parse(commandArgs: string[]) {
  return parseArgs({
    args: commandArgs,
    allowPositionals: true,
    strict: true,
    options: {
      auth: { type: "string" },
      consent: { type: "string" },
      "dry-run": { type: "boolean" },
      function: { type: "string" },
      help: { type: "boolean" },
      "no-config": { type: "boolean" },
      "server-name": { type: "string" },
      token: { type: "string" },
      url: { type: "string" },
      yes: { type: "boolean", short: "y" },
    },
  });
}

function choice<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
  label: string,
): T {
  const selected = value ?? fallback;
  if (!allowed.includes(selected as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return selected as T;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const reader = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await reader.question(`${question} [y/N] `);
  reader.close();
  return /^y(?:es)?$/i.test(answer.trim());
}

async function init(args: string[]): Promise<void> {
  const parsed = parse(args);
  const root = await findSupabaseProject(process.cwd());
  const functionName = parsed.values.function ?? "mcp";
  const auth = choice(
    parsed.values.auth,
    ["oauth", "bearer", "public"] as const,
    "oauth",
    "--auth",
  );
  if (auth === "public" && parsed.values.auth !== "public") {
    throw new Error(
      "Public mode must be selected explicitly with --auth public",
    );
  }
  const consent = choice(
    parsed.values.consent,
    ["none", "minimal"] as const,
    "none",
    "--consent",
  );
  const files = await planInit({
    cwd: root,
    functionName,
    serverName: parsed.values["server-name"] ?? basename(root),
    auth,
    consent,
    patchConfig: !parsed.values["no-config"],
  });
  console.log(`\nFile plan:\n${displayPlan(files, root)}\n`);
  const conflicts = files.filter((file) => file.status === "conflict");
  if (conflicts.length > 0) {
    throw new Error("Resolve the listed file conflicts, then run init again.");
  }
  if (parsed.values["dry-run"]) return;
  if (!parsed.values.yes && !(await confirm("Apply this plan?"))) {
    throw new Error(
      "No files changed. Re-run with --yes for non-interactive use.",
    );
  }
  await applyPlan(files);
  console.log(`Created Supabase MCP function '${functionName}'.`);
  if (auth === "public") {
    console.log(
      "\nPublic mode includes a 60 request/minute Postgres rate limit.",
    );
    console.log(
      "Apply its migration before serving or deploying:\n  supabase db push",
    );
  }
  console.log(`\nNext:\n  supabase functions serve ${functionName}`);
  console.log(`  supabase functions deploy ${functionName} --no-verify-jwt`);
  console.log(`  create-supabase-mcp doctor --function ${functionName}`);
}

async function doctor(args: string[]): Promise<void> {
  const parsed = parse(args);
  const checks = await runDoctor({
    cwd: process.cwd(),
    functionName: parsed.values.function ?? "mcp",
    url: parsed.values.url,
    token: parsed.values.token,
  });
  for (const check of checks) {
    console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
  }
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

async function dev(args: string[]): Promise<void> {
  const parsed = parse(args);
  const functionName = parsed.values.function ?? "mcp";
  const root = await findSupabaseProject(process.cwd());
  console.log(`Serving http://127.0.0.1:54321/functions/v1/${functionName}`);
  const child = spawn("supabase", ["functions", "serve", functionName], {
    cwd: root,
    stdio: "inherit",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Supabase CLI exited on ${signal}`));
      else if (code === 0) resolve();
      else reject(new Error(`Supabase CLI exited with code ${code}`));
    });
  });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }
  if (command === "init") return init(args);
  if (command === "doctor") return doctor(args);
  if (command === "dev") return dev(args);
  throw new Error(`Unknown command '${command}'.\n\n${HELP}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
