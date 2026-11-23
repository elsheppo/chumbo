import { access, readFile } from "node:fs/promises";
import { PACKAGE_VERSION } from "./project.js";
import type {
  ApiKeyStrategy,
  GeneratedAuthInspection,
  SetupAuthMode,
} from "./setup.js";

export type McpScaffoldKind =
  | "chumbo-app"
  | "chumbo-pipeline"
  | "supabase-official";

export interface McpEntryInspection extends GeneratedAuthInspection {
  readonly kind: McpScaffoldKind;
  /** True when an official Supabase MCP entry can be surgically patched without user conflict resolution. */
  readonly adoptable?: boolean;
  /** Reason adoption requires manual edits when `kind === "supabase-official" && !adoptable`. */
  readonly adoptionBlocker?: string;
}

export interface PlanOfficialAdoptionOptions {
  readonly entryPath: string;
  readonly currentSource: string;
  readonly serverName: string;
  readonly serverVersion?: string;
  /** True when the function uses bare `npm:` specifiers with no `deno.json` import map. */
  readonly usesBareNpmSpecifiers?: boolean;
  readonly packageVersion?: string;
  /** Extra property lines inserted inside `withChumbo({ ... })` (e.g. Cloud `onEvent` / `onSurface`). */
  readonly extraWithChumboProperties?: readonly string[];
  /** Extra import lines inserted at the top of the file if absent. */
  readonly extraImports?: readonly string[];
}

export interface OfficialAdoptionPlan {
  readonly status: "update" | "conflict";
  readonly entryPath: string;
  readonly source: string;
  readonly adoptable: boolean;
  readonly blocker?: string;
  readonly instrumentedServer: boolean;
  readonly advisoryTip?: string;
  readonly addedImports: readonly string[];
  readonly manualSnippet: string;
}

/**
 * Mask single-line comments, block comments, and string/template literals with
 * spaces while preserving exact character offsets and newlines.
 */
export function maskCommentsAndStrings(source: string): string {
  const out = new Array<string>(source.length);
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (lineComment) {
      if (ch === "\n") {
        lineComment = false;
        out[i] = "\n";
      } else {
        out[i] = " ";
      }
      continue;
    }

    if (blockComment) {
      if (ch === "*" && next === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        blockComment = false;
        i += 1;
      } else {
        out[i] = ch === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (quote) {
      if (ch === "\\") {
        out[i] = " ";
        if (i + 1 < source.length) {
          out[i + 1] = source[i + 1] === "\n" ? "\n" : " ";
          i += 1;
        }
        continue;
      }
      if (ch === quote) {
        quote = null;
        out[i] = " ";
        continue;
      }
      out[i] = ch === "\n" ? "\n" : " ";
      continue;
    }

    if (ch === "/" && next === "/") {
      lineComment = true;
      out[i] = " ";
      out[i + 1] = " ";
      i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      blockComment = true;
      out[i] = " ";
      out[i + 1] = " ";
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out[i] = " ";
      continue;
    }

    out[i] = ch;
  }

  return out.join("");
}

/**
 * Strip comments only (leaving string literals intact for import/config inspection)
 * while preserving exact character offsets.
 */
function maskCommentsOnly(source: string): string {
  const out = new Array<string>(source.length);
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (lineComment) {
      if (ch === "\n") {
        lineComment = false;
        out[i] = "\n";
      } else {
        out[i] = " ";
      }
      continue;
    }

    if (blockComment) {
      if (ch === "*" && next === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        blockComment = false;
        i += 1;
      } else {
        out[i] = ch === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (quote) {
      out[i] = ch;
      if (ch === "\\") {
        if (i + 1 < source.length) {
          out[i + 1] = source[i + 1]!;
          i += 1;
        }
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "/" && next === "/") {
      lineComment = true;
      out[i] = " ";
      out[i + 1] = " ";
      i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      blockComment = true;
      out[i] = " ";
      out[i + 1] = " ";
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
    }
    out[i] = ch;
  }

  return out.join("");
}

export function findMatchingDelimiter(
  masked: string,
  openIndex: number,
  openChar: "(" | "[" | "{",
  closeChar: ")" | "]" | "}",
): number {
  if (masked[openIndex] !== openChar) return -1;
  let depth = 0;
  for (let i = openIndex; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === openChar) depth += 1;
    else if (ch === closeChar && --depth === 0) return i;
  }
  return -1;
}

export interface CallSpan {
  readonly nameStart: number;
  readonly openParen: number;
  readonly closeParen: number;
}

/** Find all call sites of `identifier(<optional generics>)(...)` in masked source. */
export function findIdentifierCalls(
  masked: string,
  identifier: string,
): CallSpan[] {
  const results: CallSpan[] = [];
  const pattern = new RegExp(`\\b${identifier}\\b`, "gu");
  for (const match of masked.matchAll(pattern)) {
    const start = match.index;
    const prev = start > 0 ? masked[start - 1] : "";
    if (prev === ".") continue;
    let cursor = start + identifier.length;
    while (/\s/u.test(masked[cursor] ?? "")) cursor += 1;
    if (masked[cursor] === "<") {
      let depth = 0;
      for (; cursor < masked.length; cursor += 1) {
        if (masked[cursor] === "<") depth += 1;
        else if (masked[cursor] === ">" && --depth === 0) {
          cursor += 1;
          break;
        }
      }
      if (depth !== 0) continue;
      while (/\s/u.test(masked[cursor] ?? "")) cursor += 1;
    }
    if (masked[cursor] !== "(") continue;
    const closeParen = findMatchingDelimiter(masked, cursor, "(", ")");
    if (closeParen < 0) continue;
    results.push({ nameStart: start, openParen: cursor, closeParen });
  }
  return results;
}

/** Split top-level comma-separated argument spans inside `(...)` or `[...]`. */
function topLevelCommaSpans(
  masked: string,
  start: number,
  end: number,
): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let itemStart = start;
  for (let i = start; i < end; i += 1) {
    const ch = masked[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      const slice = masked.slice(itemStart, i);
      if (slice.trim().length > 0) {
        spans.push({ start: itemStart, end: i });
      }
      itemStart = i + 1;
    }
  }
  const tail = masked.slice(itemStart, end);
  if (tail.trim().length > 0) {
    spans.push({ start: itemStart, end });
  }
  return spans;
}

function inferChumboAppAuth(noComments: string): {
  mode?: SetupAuthMode;
  apiKeyStrategy?: ApiKeyStrategy;
} {
  if (/mode:\s*["']multi["']/.test(noComments)) return {};
  if (/mode:\s*["']public["']/.test(noComments)) return { mode: "public" };
  if (/mode:\s*["']api-key["']/.test(noComments)) {
    const apiKeyStrategy: ApiKeyStrategy = /\bverify\s*(?:\(|:)/.test(
      noComments,
    )
      ? "verifier"
      : /MCP_API_KEY/.test(noComments)
        ? "static"
        : "unknown";
    return { mode: "api-key", apiKeyStrategy };
  }
  if (/mode:\s*["']bearer["']/.test(noComments)) return { mode: "bearer" };
  if (/mode:\s*["']oauth["']/.test(noComments)) return { mode: "oauth" };
  return {};
}

function inferWithSupabaseAuth(
  noComments: string,
  masked: string,
  call: CallSpan | undefined,
): { mode?: SetupAuthMode; apiKeyStrategy?: ApiKeyStrategy } {
  const hasOauthResource =
    findIdentifierCalls(masked, "withOAuthProtectedResource").length > 0;
  if (!call) {
    return { mode: hasOauthResource ? "oauth" : "bearer" };
  }
  const argText = noComments.slice(call.openParen + 1, call.closeParen);
  if (/\bauth\s*:\s*\[/u.test(argText)) {
    return {};
  }
  const authMatch = /\bauth\s*:\s*["']([^"']+)["']/u.exec(argText);
  const authValue = authMatch?.[1];
  if (!authValue || authValue === "user") {
    return { mode: hasOauthResource ? "oauth" : "bearer" };
  }
  if (authValue === "none") {
    return { mode: "public" };
  }
  if (
    authValue === "secret" ||
    authValue.startsWith("secret:") ||
    authValue === "publishable" ||
    authValue.startsWith("publishable:")
  ) {
    return { mode: "api-key", apiKeyStrategy: "static" };
  }
  return {};
}

interface AdoptionPlacement {
  readonly form: "pipeline" | "direct";
  readonly withSupabaseCall: CallSpan;
  readonly pipelineCall?: CallSpan;
  readonly handlerSpan?: { readonly start: number; readonly end: number };
}

function analyzeOfficialPlacement(
  masked: string,
  withSupabaseCalls: readonly CallSpan[],
): { readonly placement?: AdoptionPlacement; readonly blocker?: string } {
  if (withSupabaseCalls.length === 0) {
    return {
      blocker: "No withSupabase(...) call was found in this entrypoint.",
    };
  }
  if (withSupabaseCalls.length > 1) {
    return {
      blocker:
        "Multiple withSupabase(...) calls were found; add withChumbo(...) manually after the target call.",
    };
  }
  const wsCall = withSupabaseCalls[0]!;
  const pipelineCalls = findIdentifierCalls(masked, "pipeline");

  for (const pipeCall of pipelineCalls) {
    if (
      wsCall.nameStart > pipeCall.openParen &&
      wsCall.closeParen < pipeCall.closeParen
    ) {
      const pipeArgs = topLevelCommaSpans(
        masked,
        pipeCall.openParen + 1,
        pipeCall.closeParen,
      );
      const firstArg = pipeArgs[0];
      if (!firstArg) {
        return {
          blocker: "pipeline(...) has no entries array to patch safely.",
        };
      }
      const trimmedStart =
        firstArg.start +
        (masked.slice(firstArg.start, firstArg.end).match(/^\s*/)?.[0].length ??
          0);
      if (masked[trimmedStart] !== "[") {
        return {
          blocker:
            "pipeline(...) does not use an inline array literal; add withChumbo(...) after withSupabase(...) manually.",
        };
      }
      const arrayClose = findMatchingDelimiter(masked, trimmedStart, "[", "]");
      if (arrayClose < 0 || wsCall.closeParen > arrayClose) {
        return {
          blocker:
            "withSupabase(...) is outside the pipeline(...) entries array; add withChumbo(...) manually.",
        };
      }
      const entries = topLevelCommaSpans(masked, trimmedStart + 1, arrayClose);
      for (const entry of entries) {
        if (
          masked.slice(entry.start, entry.end).trimStart().startsWith("...")
        ) {
          return {
            blocker:
              "pipeline([...]) contains a dynamic spread entry; add withChumbo(...) after withSupabase(...) manually.",
          };
        }
      }
      return {
        placement: {
          form: "pipeline",
          withSupabaseCall: wsCall,
          pipelineCall: pipeCall,
          handlerSpan: pipeArgs[1],
        },
      };
    }
  }

  // Form B: direct `withSupabase(config, handler)` wrapper.
  const wsArgs = topLevelCommaSpans(
    masked,
    wsCall.openParen + 1,
    wsCall.closeParen,
  );
  if (wsArgs.length >= 2) {
    return {
      placement: {
        form: "direct",
        withSupabaseCall: wsCall,
        handlerSpan: wsArgs[1],
      },
    };
  }

  return {
    blocker:
      "withSupabase(...) is neither inside an inline pipeline([...]) array nor wrapping a handler argument; add withChumbo(...) manually.",
  };
}

/**
 * Inspect an MCP entrypoint's source using a comment/string-aware lexer.
 * Returns `undefined` when the file is not a Chumbo or official Supabase MCP entry.
 */
export function inspectMcpEntrySource(
  source: string,
): McpEntryInspection | undefined {
  const noComments = maskCommentsOnly(source);
  const masked = maskCommentsAndStrings(source);

  const stateNamespace = /namespaces:\s*\{\s*["']([^"']+)["']\s*:/.exec(
    noComments,
  )?.[1];
  const state = stateNamespace ? { stateNamespace } : {};

  const createAppCalls = findIdentifierCalls(masked, "createSupabaseMcp");
  if (createAppCalls.length > 0) {
    const auth = inferChumboAppAuth(noComments);
    return {
      kind: "chumbo-app",
      mode: auth.mode ?? ("oauth" as SetupAuthMode),
      ...(auth.apiKeyStrategy ? { apiKeyStrategy: auth.apiKeyStrategy } : {}),
      ...state,
    };
  }

  const withChumboCalls = findIdentifierCalls(masked, "withChumbo");
  const withSupabaseCalls = findIdentifierCalls(masked, "withSupabase");

  if (withChumboCalls.length > 0) {
    const auth = inferWithSupabaseAuth(
      noComments,
      masked,
      withSupabaseCalls[0],
    );
    return {
      kind: "chumbo-pipeline",
      mode: auth.mode ?? ("oauth" as SetupAuthMode),
      ...(auth.apiKeyStrategy ? { apiKeyStrategy: auth.apiKeyStrategy } : {}),
      ...state,
    };
  }

  const importsSupabaseServer =
    /from\s+["'](?:npm:)?@supabase\/server(?:[@/"'])/u.test(noComments);
  const importsMcpServer =
    /from\s+["'](?:npm:)?@modelcontextprotocol\/server(?:[@/"'])/u.test(
      noComments,
    );
  const usesMcpPrimitive =
    /\b(?:McpServer|createMcpHandler|WebStandardStreamableHTTPServerTransport)\b/u.test(
      masked,
    );

  if (
    importsSupabaseServer &&
    importsMcpServer &&
    usesMcpPrimitive &&
    withSupabaseCalls.length > 0
  ) {
    const auth = inferWithSupabaseAuth(
      noComments,
      masked,
      withSupabaseCalls[0],
    );
    const { placement, blocker } = analyzeOfficialPlacement(
      masked,
      withSupabaseCalls,
    );
    return {
      kind: "supabase-official",
      mode: auth.mode ?? ("oauth" as SetupAuthMode),
      ...(auth.apiKeyStrategy ? { apiKeyStrategy: auth.apiKeyStrategy } : {}),
      ...state,
      adoptable: Boolean(placement),
      ...(blocker ? { adoptionBlocker: blocker } : {}),
    };
  }

  return undefined;
}

/**
 * Inspect whether `source` explicitly configures multi/array auth (so callers
 * like `inspectGeneratedAuthAt` return `undefined` and let `doctor` read live headers).
 */
export function hasComposedOrMultiAuth(source: string): boolean {
  const noComments = maskCommentsOnly(source);
  const masked = maskCommentsAndStrings(source);
  if (/mode:\s*["']multi["']/.test(noComments)) return true;
  const wsCalls = findIdentifierCalls(masked, "withSupabase");
  if (wsCalls.length === 1) {
    const argText = noComments.slice(
      wsCalls[0]!.openParen + 1,
      wsCalls[0]!.closeParen,
    );
    if (/\bauth\s*:\s*\[/u.test(argText)) return true;
  }
  return false;
}

export async function inspectMcpEntryAt(
  path: string,
): Promise<McpEntryInspection | undefined> {
  try {
    await access(path);
  } catch {
    return undefined;
  }
  const source = await readFile(path, "utf8");
  return inspectMcpEntrySource(source);
}

function buildWithChumboConfigLiteral(
  serverName: string,
  serverVersion: string,
  extraProperties: readonly string[] = [],
): string {
  const lines = [
    `server: { name: ${JSON.stringify(serverName)}, version: ${JSON.stringify(serverVersion)} },`,
    ...extraProperties.map((line) => line.trim()).filter(Boolean),
  ];
  return `{\n    ${lines.join("\n    ")}\n  }`;
}

function buildManualSnippet(
  serverName: string,
  serverVersion: string,
  usesBareNpmSpecifiers: boolean,
  packageVersion: string,
  extraProperties: readonly string[] = [],
): string {
  const importSpec = usesBareNpmSpecifiers
    ? `npm:chumbo@${packageVersion}/middleware`
    : "chumbo/middleware";
  const cfg = buildWithChumboConfigLiteral(
    serverName,
    serverVersion,
    extraProperties,
  );
  return `import { withChumbo } from "${importSpec}";\n\n// Place immediately after withSupabase(...) in pipeline([...]):\nwithChumbo(${cfg}),`;
}

/**
 * Attempt to find an inline `(req, ctx) => ...` or `async function (req, ctx) { ... }`
 * handler's second parameter name when it is a plain identifier (not destructured).
 */
function inlineHandlerContextParam(handlerSource: string): string | undefined {
  const match =
    /^\s*(?:async\s+)?(?:function\s*(?:[A-Za-z_$][\w$]*)?\s*)?\(\s*[A-Za-z_$][\w$]*(?:\s*:\s*[^,)]+)?\s*,\s*([A-Za-z_$][\w$]*)(?:\s*:\s*[^,)]+)?\s*\)/u.exec(
      handlerSource,
    );
  return match?.[1];
}

function wrapNewMcpServerInHandler(
  handlerSource: string,
  ctxIdent: string,
): { readonly source: string; readonly wrapped: boolean } {
  const masked = maskCommentsAndStrings(handlerSource);
  // Skip if the handler already calls `.chumbo.instrument(` or shadows `ctxIdent`.
  if (
    new RegExp(
      `\\b${ctxIdent}\\s*\\.\\s*chumbo\\s*\\.\\s*instrument\\s*\\(`,
      "u",
    ).test(masked) ||
    new RegExp(`\\b(?:const|let|var)\\s+${ctxIdent}\\b`, "u").test(masked)
  ) {
    return { source: handlerSource, wrapped: false };
  }
  const match = /\bnew\s+McpServer\s*\(/u.exec(masked);
  if (!match) return { source: handlerSource, wrapped: false };
  const openParen = match.index + match[0].length - 1;
  const closeParen = findMatchingDelimiter(masked, openParen, "(", ")");
  if (closeParen < 0) return { source: handlerSource, wrapped: false };

  const wrappedSource =
    handlerSource.slice(0, match.index) +
    `${ctxIdent}.chumbo.instrument(${handlerSource.slice(match.index, closeParen + 1)})` +
    handlerSource.slice(closeParen + 1);
  return { source: wrappedSource, wrapped: true };
}

function insertImports(
  source: string,
  importLines: readonly string[],
): { readonly source: string; readonly added: string[] } {
  const added = importLines.filter((line) => !source.includes(line));
  if (added.length === 0) return { source, added: [] };
  const lines = source.split("\n");
  let insertAt = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*import\b/u.test(lines[i]!)) {
      insertAt = i + 1;
    } else if (insertAt > 0 && lines[i]!.trim().length > 0) {
      break;
    }
  }
  const nextLines = [
    ...lines.slice(0, insertAt),
    ...added,
    ...lines.slice(insertAt),
  ];
  return { source: nextLines.join("\n"), added };
}

/**
 * Compute a non-destructive surgical adoption plan for an official `@supabase/server`
 * MCP entrypoint, injecting `withChumbo(...)` without replacing `index.ts`.
 */
export function planOfficialAdoption(
  options: PlanOfficialAdoptionOptions,
): OfficialAdoptionPlan {
  const serverVersion = options.serverVersion ?? "1.0.0";
  const packageVersion = options.packageVersion ?? PACKAGE_VERSION;
  const usesBareNpmSpecifiers =
    options.usesBareNpmSpecifiers ??
    /from\s+["']npm:@supabase\/server/u.test(options.currentSource);
  const manualSnippet = buildManualSnippet(
    options.serverName,
    serverVersion,
    usesBareNpmSpecifiers,
    packageVersion,
    options.extraWithChumboProperties,
  );

  const inspection = inspectMcpEntrySource(options.currentSource);
  if (!inspection || inspection.kind !== "supabase-official") {
    return {
      status: "conflict",
      entryPath: options.entryPath,
      source: options.currentSource,
      adoptable: false,
      blocker:
        "Entrypoint is not an official @supabase/server MCP function that can be adopted automatically.",
      instrumentedServer: false,
      addedImports: [],
      manualSnippet,
    };
  }

  const masked = maskCommentsAndStrings(options.currentSource);
  const wsCalls = findIdentifierCalls(masked, "withSupabase");
  const { placement, blocker } = analyzeOfficialPlacement(masked, wsCalls);
  if (!placement) {
    return {
      status: "conflict",
      entryPath: options.entryPath,
      source: options.currentSource,
      adoptable: false,
      blocker,
      instrumentedServer: false,
      addedImports: [],
      manualSnippet,
    };
  }

  const cfg = buildWithChumboConfigLiteral(
    options.serverName,
    serverVersion,
    options.extraWithChumboProperties,
  );

  let workingSource = options.currentSource;
  let instrumentedServer = false;

  // Apply handler instrumentation first (higher offsets) before inserting withChumbo (lower offsets).
  if (placement.handlerSpan) {
    const rawHandler = workingSource.slice(
      placement.handlerSpan.start,
      placement.handlerSpan.end,
    );
    const ctxIdent = inlineHandlerContextParam(rawHandler);
    if (ctxIdent) {
      const wrapped = wrapNewMcpServerInHandler(rawHandler, ctxIdent);
      if (wrapped.wrapped) {
        workingSource =
          workingSource.slice(0, placement.handlerSpan.start) +
          wrapped.source +
          workingSource.slice(placement.handlerSpan.end);
        instrumentedServer = true;
      }
    }
  }

  // Re-locate placement on workingSource after optional handler instrumentation.
  const maskedAfter = maskCommentsAndStrings(workingSource);
  const wsCallAfter = findIdentifierCalls(maskedAfter, "withSupabase")[0]!;
  const { placement: placementAfter } = analyzeOfficialPlacement(maskedAfter, [
    wsCallAfter,
  ]);
  if (!placementAfter) {
    return {
      status: "conflict",
      entryPath: options.entryPath,
      source: options.currentSource,
      adoptable: false,
      blocker: "Could not safely re-locate withSupabase(...) insertion point.",
      instrumentedServer: false,
      addedImports: [],
      manualSnippet,
    };
  }

  if (placementAfter.form === "pipeline") {
    const afterWs = placementAfter.withSupabaseCall.closeParen + 1;
    let insertOffset = afterWs;
    while (/\s/u.test(workingSource[insertOffset] ?? "")) insertOffset += 1;
    if (workingSource[insertOffset] === ",") {
      insertOffset += 1;
      workingSource =
        workingSource.slice(0, insertOffset) +
        `\n      withChumbo(${cfg}),` +
        workingSource.slice(insertOffset);
    } else {
      workingSource =
        workingSource.slice(0, afterWs) +
        `,\n      withChumbo(${cfg})` +
        workingSource.slice(afterWs);
    }
  } else {
    const handlerSpan = placementAfter.handlerSpan!;
    const rawHandler = workingSource.slice(handlerSpan.start, handlerSpan.end);
    const leadingWs = rawHandler.match(/^\s*/)?.[0] ?? "";
    const trimmedHandler = rawHandler.trim();
    workingSource =
      workingSource.slice(0, handlerSpan.start) +
      `${leadingWs}withChumbo(${cfg}, ${trimmedHandler})` +
      workingSource.slice(handlerSpan.end);
  }

  const importSpec = usesBareNpmSpecifiers
    ? `npm:chumbo@${packageVersion}/middleware`
    : "chumbo/middleware";
  const desiredImports = [
    `import { withChumbo } from "${importSpec}";`,
    ...(options.extraImports ?? []),
  ];
  const withImports = insertImports(workingSource, desiredImports);

  return {
    status: "update",
    entryPath: options.entryPath,
    source: withImports.source,
    adoptable: true,
    instrumentedServer,
    ...(!instrumentedServer
      ? {
          advisoryTip:
            "Wrap `new McpServer(...)` with `ctx.chumbo.instrument(server)` inside your handler to enable `server.withScopes(...)`, `resultMiddleware`, and `onEvent`.",
        }
      : {}),
    addedImports: withImports.added,
    manualSnippet,
  };
}
