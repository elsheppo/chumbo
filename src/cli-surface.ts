import {
  CHUMBO_CAPABILITY_META_KEY,
  type ChumboCapabilityManifestV1,
  type ChumboCapabilityRisk,
  type ChumboCliPresentation,
} from "./capabilities.js";

export interface CliToolDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<Record<string, unknown>>;
  readonly _meta?: Readonly<Record<string, unknown>>;
}

export interface CliCapability {
  readonly id: string;
  readonly mcpName: string;
  readonly title: string;
  readonly description: string;
  readonly command: readonly string[];
  readonly risk: ChumboCapabilityRisk;
  readonly idempotent: boolean;
  readonly scopes: readonly string[];
  readonly presentation: ChumboCliPresentation;
  readonly examples: readonly string[];
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly authored: boolean;
}

export interface CliInvocation {
  readonly capability: CliCapability;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly json: boolean;
  readonly confirmed: boolean;
}

const commandSegment = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function manifestFrom(
  tool: CliToolDescriptor,
): ChumboCapabilityManifestV1 | null {
  const value = record(tool._meta?.[CHUMBO_CAPABILITY_META_KEY]);
  if (
    value?.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    value.mcpName !== tool.name ||
    !["read", "write", "destructive"].includes(String(value.risk)) ||
    typeof value.idempotent !== "boolean" ||
    !Array.isArray(value.scopes) ||
    !value.scopes.every((scope) => typeof scope === "string")
  ) {
    return null;
  }
  const cli = record(value.cli);
  if (
    !cli ||
    !Array.isArray(cli.command) ||
    cli.command.length === 0 ||
    !cli.command.every(
      (segment) => typeof segment === "string" && commandSegment.test(segment),
    )
  ) {
    return null;
  }
  return value as unknown as ChumboCapabilityManifestV1;
}

function inferredRisk(tool: CliToolDescriptor): ChumboCapabilityRisk {
  if (tool.annotations?.destructiveHint === true) return "destructive";
  if (tool.annotations?.readOnlyHint === true) return "read";
  return "write";
}

export function cliCapabilities(
  tools: readonly CliToolDescriptor[],
): readonly CliCapability[] {
  const commands = new Set<string>();
  return tools
    .map((tool): CliCapability => {
      const manifest = manifestFrom(tool);
      const command = manifest?.cli.command ?? ["run", tool.name];
      const key = command.join("\u0000");
      if (commands.has(key)) {
        throw new TypeError(`Duplicate CLI command: ${command.join(" ")}`);
      }
      commands.add(key);
      return Object.freeze({
        id: manifest?.id ?? tool.name,
        mcpName: tool.name,
        title: tool.title ?? tool.name,
        description: manifest?.cli.description ?? tool.description ?? "",
        command: Object.freeze([...command]),
        risk: manifest?.risk ?? inferredRisk(tool),
        idempotent:
          manifest?.idempotent ?? tool.annotations?.idempotentHint === true,
        scopes: Object.freeze([...(manifest?.scopes ?? [])]),
        presentation: manifest?.cli.presentation ?? "auto",
        examples: Object.freeze([...(manifest?.cli.examples ?? [])]),
        inputSchema: Object.freeze({ ...(tool.inputSchema ?? {}) }),
        authored: manifest !== null,
      });
    })
    .sort((left, right) =>
      left.command.join(" ").localeCompare(right.command.join(" ")),
    );
}

function propertyName(
  properties: Record<string, unknown>,
  flag: string,
): string | null {
  if (Object.hasOwn(properties, flag)) return flag;
  const snake = flag.replaceAll("-", "_");
  if (Object.hasOwn(properties, snake)) return snake;
  const camel = flag.replace(/-([a-z])/gu, (_, letter: string) =>
    letter.toUpperCase(),
  );
  return Object.hasOwn(properties, camel) ? camel : null;
}

function parseValue(value: string, schema: unknown): unknown {
  const shape = record(schema);
  switch (shape?.type) {
    case "boolean":
      if (value === "true") return true;
      if (value === "false") return false;
      throw new TypeError(`Expected true or false, received ${value}`);
    case "integer": {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) {
        throw new TypeError(`Expected an integer, received ${value}`);
      }
      return parsed;
    }
    case "number": {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        throw new TypeError(`Expected a number, received ${value}`);
      }
      return parsed;
    }
    case "array":
    case "object":
      try {
        return JSON.parse(value) as unknown;
      } catch {
        throw new TypeError(`Expected JSON for ${String(shape.type)}`);
      }
    default:
      return value;
  }
}

function matchCapability(
  capabilities: readonly CliCapability[],
  argv: readonly string[],
): { capability: CliCapability; rest: readonly string[] } {
  const matches = capabilities
    .filter((item) =>
      item.command.every((segment, index) => argv[index] === segment),
    )
    .sort((left, right) => right.command.length - left.command.length);
  const capability = matches[0];
  if (!capability) throw new TypeError("Unknown command");
  return { capability, rest: argv.slice(capability.command.length) };
}

export function parseCliInvocation(
  capabilities: readonly CliCapability[],
  argv: readonly string[],
): CliInvocation {
  const { capability, rest } = matchCapability(capabilities, argv);
  const root = record(capability.inputSchema) ?? {};
  const properties = record(root.properties) ?? {};
  const required = Array.isArray(root.required)
    ? root.required.filter((item): item is string => typeof item === "string")
    : [];
  const args: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  let json = false;
  let confirmed = false;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--yes") {
      confirmed = true;
      continue;
    }
    if (token === "--args") {
      const source = rest[++index];
      if (!source) throw new TypeError("--args requires a JSON object");
      let parsed: Record<string, unknown> | null;
      try {
        parsed = record(JSON.parse(source) as unknown);
      } catch {
        throw new TypeError("--args requires a JSON object");
      }
      if (!parsed) throw new TypeError("--args requires a JSON object");
      if (
        ["__proto__", "constructor", "prototype"].some((key) =>
          Object.hasOwn(parsed, key),
        )
      ) {
        throw new TypeError("--args contains a reserved property");
      }
      Object.assign(args, parsed);
      continue;
    }
    if (!token.startsWith("--")) {
      throw new TypeError(`Unexpected argument: ${token}`);
    }
    const flag = token.slice(2);
    const name = propertyName(properties, flag);
    if (!name) throw new TypeError(`Unknown option: ${token}`);
    const schema = record(properties[name]);
    if (
      schema?.type === "boolean" &&
      (rest[index + 1] === undefined || rest[index + 1]?.startsWith("--"))
    ) {
      args[name] = true;
      continue;
    }
    const value = rest[++index];
    if (value === undefined) throw new TypeError(`${token} requires a value`);
    args[name] = parseValue(value, schema);
  }
  const missing = required.filter((name) => args[name] === undefined);
  if (missing.length > 0) {
    throw new TypeError(`Missing required options: ${missing.join(", ")}`);
  }
  return Object.freeze({
    capability,
    arguments: Object.freeze(args),
    json,
    confirmed,
  });
}

export function invocationNeedsConfirmation(
  invocation: CliInvocation,
): boolean {
  return invocation.capability.risk !== "read" && !invocation.confirmed;
}
