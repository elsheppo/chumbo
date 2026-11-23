import type { BrandedCliConfig } from "./cli-host.js";
import type { CliCapability } from "./cli-surface.js";

export type CompletionShell = "zsh" | "bash" | "fish";

export const COMPLETION_SHELLS = Object.freeze([
  "zsh",
  "bash",
  "fish",
] as const);

const SAFE_SEGMENT = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const SAFE_FLAG = /^--[a-z0-9][a-z0-9-]*$/u;
const SAFE_ENUM_VALUE = /^[A-Za-z0-9._:/-]+$/u;
const MAX_ENUM_VALUES = 32;
const MAX_ENUM_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 120;

interface SynthesizedOption {
  readonly flag: string;
  readonly description: string;
  readonly takesValue: boolean;
  readonly values: readonly string[];
}

interface SynthesizedCommand {
  readonly path: readonly string[];
  readonly description: string;
  readonly options: readonly SynthesizedOption[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function sanitizeCompletionDescription(raw: string | undefined): string {
  if (!raw) return "";
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f`]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned.length > MAX_DESCRIPTION_LENGTH
    ? `${cleaned.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`
    : cleaned;
}

export function propertyToCliFlag(name: string): string | null {
  const kebab = name
    .replaceAll("_", "-")
    .replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
  const flag = `--${kebab}`;
  return SAFE_FLAG.test(flag) ? flag : null;
}

function optionValues(shape: Record<string, unknown>): readonly string[] {
  if (shape.type === "boolean") {
    return ["true", "false"];
  }
  if (
    Array.isArray(shape.enum) &&
    shape.enum.length > 0 &&
    shape.enum.length <= MAX_ENUM_VALUES
  ) {
    const allowed = shape.enum.filter(
      (entry): entry is string =>
        typeof entry === "string" &&
        entry.length > 0 &&
        entry.length <= MAX_ENUM_LENGTH &&
        SAFE_ENUM_VALUE.test(entry),
    );
    return allowed;
  }
  return [];
}

function capabilityToCommand(item: CliCapability): SynthesizedCommand | null {
  if (
    item.command.length === 0 ||
    !item.command.every((segment) => SAFE_SEGMENT.test(segment))
  ) {
    return null;
  }
  const root = record(item.inputSchema) ?? {};
  const properties = record(root.properties) ?? {};
  const seenFlags = new Set<string>([
    "--json",
    "--args",
    "--help",
    "--refresh",
    "--yes",
  ]);
  const options: SynthesizedOption[] = [];

  for (const [propName, rawSchema] of Object.entries(properties)) {
    const flag = propertyToCliFlag(propName);
    if (!flag || seenFlags.has(flag)) continue;
    seenFlags.add(flag);
    const shape = record(rawSchema) ?? {};
    const description = sanitizeCompletionDescription(
      typeof shape.description === "string" ? shape.description : undefined,
    );
    options.push({
      flag,
      description,
      takesValue: true,
      values: optionValues(shape),
    });
  }

  if (item.risk !== "read") {
    options.push({
      flag: "--yes",
      description: "Confirm this write or destructive command",
      takesValue: false,
      values: [],
    });
  }
  options.push(
    {
      flag: "--json",
      description: "Emit a stable JSON receipt",
      takesValue: false,
      values: [],
    },
    {
      flag: "--args",
      description: "Pass arguments as a JSON object",
      takesValue: true,
      values: [],
    },
    {
      flag: "--refresh",
      description: "Refresh cached MCP capability discovery",
      takesValue: false,
      values: [],
    },
    {
      flag: "--help",
      description: "Show help for this command",
      takesValue: false,
      values: [],
    },
  );

  return {
    path: item.command,
    description: sanitizeCompletionDescription(item.description || item.title),
    options,
  };
}

function builtinCommands(displayName: string): readonly SynthesizedCommand[] {
  const safeName = sanitizeCompletionDescription(displayName) || "project";
  return [
    {
      path: ["login"],
      description: `Sign in to ${safeName}`,
      options: [
        {
          flag: "--token-stdin",
          description: "Read a static token from standard input",
          takesValue: false,
          values: [],
        },
        {
          flag: "--json",
          description: "Emit a stable JSON receipt",
          takesValue: false,
          values: [],
        },
      ],
    },
    {
      path: ["logout"],
      description: `Sign out of ${safeName}`,
      options: [
        {
          flag: "--json",
          description: "Emit a stable JSON receipt",
          takesValue: false,
          values: [],
        },
      ],
    },
    {
      path: ["status"],
      description: "Verify the current session against the MCP server",
      options: [
        {
          flag: "--json",
          description: "Emit a stable JSON receipt",
          takesValue: false,
          values: [],
        },
      ],
    },
    {
      path: ["commands"],
      description: "List commands available to the current caller",
      options: [
        {
          flag: "--refresh",
          description: "Refresh cached MCP capability discovery",
          takesValue: false,
          values: [],
        },
        {
          flag: "--json",
          description: "Emit a stable JSON receipt",
          takesValue: false,
          values: [],
        },
      ],
    },
    {
      path: ["skill", "install"],
      description: `Install the ${safeName} agent skill`,
      options: [
        {
          flag: "--target",
          description: "Skill destination directory",
          takesValue: true,
          values: ["agents", "claude", "both"],
        },
        {
          flag: "--dir",
          description: "Workspace root directory",
          takesValue: true,
          values: [],
        },
        {
          flag: "--refresh",
          description: "Refresh cached MCP capability discovery",
          takesValue: false,
          values: [],
        },
        {
          flag: "--plan",
          description: "Preview proposed skill files without writing",
          takesValue: false,
          values: [],
        },
        {
          flag: "--yes",
          description: "Apply without interactive confirmation",
          takesValue: false,
          values: [],
        },
        {
          flag: "--json",
          description: "Emit a stable JSON receipt",
          takesValue: false,
          values: [],
        },
      ],
    },
    {
      path: ["skill", "status"],
      description: "Inspect installed agent skill files without writing",
      options: [
        {
          flag: "--target",
          description: "Skill destination directory",
          takesValue: true,
          values: ["agents", "claude", "both"],
        },
        {
          flag: "--dir",
          description: "Workspace root directory",
          takesValue: true,
          values: [],
        },
        {
          flag: "--json",
          description: "Emit a stable JSON receipt",
          takesValue: false,
          values: [],
        },
      ],
    },
    {
      path: ["skill", "update"],
      description: "Safely update unmodified agent skill files",
      options: [
        {
          flag: "--target",
          description: "Skill destination directory",
          takesValue: true,
          values: ["agents", "claude", "both"],
        },
        {
          flag: "--dir",
          description: "Workspace root directory",
          takesValue: true,
          values: [],
        },
        {
          flag: "--refresh",
          description: "Refresh cached MCP capability discovery",
          takesValue: false,
          values: [],
        },
        {
          flag: "--plan",
          description: "Preview proposed skill files without writing",
          takesValue: false,
          values: [],
        },
        {
          flag: "--yes",
          description: "Apply without interactive confirmation",
          takesValue: false,
          values: [],
        },
        {
          flag: "--json",
          description: "Emit a stable JSON receipt",
          takesValue: false,
          values: [],
        },
      ],
    },
    {
      path: ["completions"],
      description: "Render shell completion script",
      options: [
        {
          flag: "--refresh",
          description: "Refresh cached MCP capability discovery",
          takesValue: false,
          values: [],
        },
        {
          flag: "--offline",
          description: "Use only cached or built-in commands",
          takesValue: false,
          values: [],
        },
      ],
    },
    {
      path: ["help"],
      description: "Show CLI usage",
      options: [],
    },
  ];
}

function zshSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function zshArgSpecEscape(value: string): string {
  return value.replace(/[\\:\[\]]/gu, "\\$&");
}

function fishSingleQuote(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function renderZsh(
  binaryName: string,
  commands: readonly SynthesizedCommand[],
): string {
  const fnIdent = `_${binaryName.replaceAll("-", "_")}`;
  const topSegments = new Map<string, string>();
  for (const cmd of commands) {
    const first = cmd.path[0]!;
    if (!topSegments.has(first)) {
      topSegments.set(
        first,
        cmd.path.length === 1 ? cmd.description : `${first} commands`,
      );
    }
  }

  const rootItems = [...topSegments.entries()]
    .map(([seg, desc]) =>
      zshSingleQuote(desc ? `${seg}:${zshArgSpecEscape(desc)}` : seg),
    )
    .join(" ");

  const branches: string[] = [];
  for (const cmd of commands) {
    const key = cmd.path.join(" ");
    const specs: string[] = [];
    if (key === "completions") {
      specs.push(zshSingleQuote("1:shell:(zsh bash fish)"));
    }
    for (const opt of cmd.options) {
      const descPart = opt.description
        ? `[${zshArgSpecEscape(opt.description)}]`
        : "";
      const valuePart = opt.takesValue
        ? opt.values.length > 0
          ? `:value:(${opt.values.join(" ")})`
          : ":value:"
        : "";
      specs.push(zshSingleQuote(`${opt.flag}${descPart}${valuePart}`));
    }
    branches.push(
      `    ${zshSingleQuote(key)})\n      _arguments -s ${specs.join(" ")} ;;\n`,
    );
  }

  // Group intermediate subcommand prefixes (e.g. `projects` -> `list`, `delete`)
  const prefixChildren = new Map<string, Map<string, string>>();
  for (const cmd of commands) {
    for (let depth = 1; depth < cmd.path.length; depth += 1) {
      const prefix = cmd.path.slice(0, depth).join(" ");
      const child = cmd.path[depth]!;
      let bucket = prefixChildren.get(prefix);
      if (!bucket) {
        bucket = new Map<string, string>();
        prefixChildren.set(prefix, bucket);
      }
      if (!bucket.has(child)) {
        bucket.set(
          child,
          depth + 1 === cmd.path.length ? cmd.description : `${child} commands`,
        );
      }
    }
  }

  const prefixBranches = [...prefixChildren.entries()].map(
    ([prefix, children]) => {
      const items = [...children.entries()]
        .map(([name, desc]) =>
          zshSingleQuote(desc ? `${name}:${zshArgSpecEscape(desc)}` : name),
        )
        .join(" ");
      return `    ${zshSingleQuote(prefix)})\n      local -a subcommands=(${items})\n      _describe 'subcommand' subcommands ;;\n`;
    },
  );

  return `#compdef ${binaryName}

${fnIdent}() {
  local -a root_commands=(${rootItems})
  local -a path_tokens=()
  local idx
  for (( idx = 2; idx < CURRENT; idx++ )); do
    local word="\${words[idx]}"
    if [[ "$word" == --* ]]; then
      break
    fi
    path_tokens+=("$word")
  done

  if (( \${#path_tokens[@]} == 0 )); then
    _describe 'command' root_commands
    return
  fi

  local joined="\${(j: :)path_tokens}"
  case "$joined" in
${branches.join("")}${prefixBranches.join("")}  esac
}

compdef ${fnIdent} ${binaryName}
`;
}

function renderBash(
  binaryName: string,
  commands: readonly SynthesizedCommand[],
): string {
  const fnIdent = `_${binaryName.replaceAll("-", "_")}_completions`;
  const topWords = [...new Set(commands.map((cmd) => cmd.path[0]!))].join(" ");

  const prefixChildren = new Map<string, Set<string>>();
  for (const cmd of commands) {
    for (let depth = 1; depth < cmd.path.length; depth += 1) {
      const prefix = cmd.path.slice(0, depth).join(" ");
      let bucket = prefixChildren.get(prefix);
      if (!bucket) {
        bucket = new Set<string>();
        prefixChildren.set(prefix, bucket);
      }
      bucket.add(cmd.path[depth]!);
    }
  }

  const exactOptionMap = new Map<string, readonly SynthesizedOption[]>();
  for (const cmd of commands) {
    exactOptionMap.set(cmd.path.join(" "), cmd.options);
  }

  const caseArms: string[] = [];
  const allKeys = new Set<string>([
    ...prefixChildren.keys(),
    ...exactOptionMap.keys(),
  ]);
  for (const key of allKeys) {
    const children = [...(prefixChildren.get(key) ?? [])];
    const opts = exactOptionMap.get(key) ?? [];
    const flagWords = opts.map((opt) => opt.flag);
    const extraPositional =
      key === "completions" ? ["zsh", "bash", "fish"] : [];
    const words = [
      ...new Set([...children, ...extraPositional, ...flagWords]),
    ].join(" ");

    const prevValueCases = opts
      .filter((opt) => opt.values.length > 0)
      .map(
        (opt) =>
          `        ${opt.flag}) COMPREPLY=( $(compgen -W '${opt.values.join(" ")}' -- "$cur") ); return 0 ;;`,
      )
      .join("\n");

    caseArms.push(
      `    '${key}')\n${prevValueCases ? `      case "$prev" in\n${prevValueCases}\n      esac\n` : ""}      COMPREPLY=( $(compgen -W '${words}' -- "$cur") )\n      return 0\n      ;;`,
    );
  }

  return `${fnIdent}() {
  local cur prev idx
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  local path=""
  for (( idx = 1; idx < COMP_CWORD; idx++ )); do
    local word="\${COMP_WORDS[idx]}"
    if [[ "$word" == --* ]]; then
      break
    fi
    if [[ -z "$path" ]]; then
      path="$word"
    else
      path="$path $word"
    fi
  done

  if [[ -z "$path" ]]; then
    COMPREPLY=( $(compgen -W '${topWords} --help' -- "$cur") )
    return 0
  fi

  case "$path" in
${caseArms.join("\n")}
  esac
}

complete -F ${fnIdent} ${binaryName}
`;
}

function renderFish(
  binaryName: string,
  commands: readonly SynthesizedCommand[],
): string {
  const lines: string[] = [
    `# Fish completions for ${binaryName}`,
    `complete -c ${binaryName} -f`,
  ];

  const seenTop = new Set<string>();
  for (const cmd of commands) {
    const first = cmd.path[0]!;
    if (!seenTop.has(first)) {
      seenTop.add(first);
      const desc =
        cmd.path.length === 1 ? cmd.description : `${first} commands`;
      lines.push(
        `complete -c ${binaryName} -n '__fish_use_subcommand' -a ${fishSingleQuote(first)} -d ${fishSingleQuote(desc)}`,
      );
    }
  }

  lines.push(
    `complete -c ${binaryName} -n '__fish_seen_subcommand_from completions' -a 'zsh bash fish'`,
  );

  const seenChild = new Set<string>();
  for (const cmd of commands) {
    if (cmd.path.length >= 2) {
      const parent = cmd.path[0]!;
      const sub = cmd.path[1]!;
      const pairKey = `${parent}\u0000${sub}`;
      if (!seenChild.has(pairKey)) {
        seenChild.add(pairKey);
        lines.push(
          `complete -c ${binaryName} -n '__fish_seen_subcommand_from ${parent}; and not __fish_seen_subcommand_from ${sub}' -a ${fishSingleQuote(sub)} -d ${fishSingleQuote(cmd.description)}`,
        );
      }
    }

    const condParts = cmd.path.map(
      (seg) => `__fish_seen_subcommand_from ${seg}`,
    );
    const cond = condParts.join("; and ");
    for (const opt of cmd.options) {
      const longName = opt.flag.slice(2);
      const reqFlag = opt.takesValue ? " -r" : "";
      const valAttr =
        opt.values.length > 0
          ? ` -a ${fishSingleQuote(opt.values.join(" "))}`
          : "";
      const descAttr = opt.description
        ? ` -d ${fishSingleQuote(opt.description)}`
        : "";
      lines.push(
        `complete -c ${binaryName} -n '${cond}' -l ${fishSingleQuote(longName)}${reqFlag}${valAttr}${descAttr}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export function renderShellCompletions(
  shell: CompletionShell,
  config: BrandedCliConfig,
  capabilities: readonly CliCapability[],
): string {
  if (!SAFE_SEGMENT.test(config.binaryName)) {
    throw new TypeError("binaryName must be lowercase kebab-case");
  }
  if (!COMPLETION_SHELLS.includes(shell)) {
    throw new TypeError(
      `Unsupported shell '${String(shell)}'. Expected one of: zsh, bash, fish.`,
    );
  }
  const commands: SynthesizedCommand[] = [
    ...builtinCommands(config.displayName),
    ...capabilities
      .map(capabilityToCommand)
      .filter((item): item is SynthesizedCommand => item !== null),
  ];

  if (shell === "zsh") return renderZsh(config.binaryName, commands);
  if (shell === "bash") return renderBash(config.binaryName, commands);
  return renderFish(config.binaryName, commands);
}
