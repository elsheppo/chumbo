import {
  isCallToolResult,
  type CallToolResult,
  type ResourceLink,
} from "@modelcontextprotocol/server";

const MAX_ADDED_RESULT_BLOCKS = 16;
const MAX_ADDED_RESULT_BYTES = 64 * 1024;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ResourceResultLink = ResourceLink;
export type ResultContentBlock = CallToolResult["content"][number];

export interface ResultContentComposition {
  /** Content inserted before every block authored by the tool handler. */
  readonly prepend?: readonly ResultContentBlock[];
  /** Content inserted after every block authored by the tool handler. */
  readonly append?: readonly ResultContentBlock[];
}

function addedContent(
  composition: ResultContentComposition,
): Required<ResultContentComposition> {
  const prepend = composition.prepend ?? [];
  const append = composition.append ?? [];
  const added = [...prepend, ...append];
  if (added.length > MAX_ADDED_RESULT_BLOCKS) {
    throw new RangeError(
      `Result composition may add at most ${MAX_ADDED_RESULT_BLOCKS} content blocks`,
    );
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(added);
  } catch {
    throw new TypeError("Result composition content must be JSON serializable");
  }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > MAX_ADDED_RESULT_BYTES) {
    throw new RangeError(
      `Result composition may add at most ${MAX_ADDED_RESULT_BYTES} encoded bytes`,
    );
  }
  const snapshot = JSON.parse(serialized) as ResultContentBlock[];
  if (!isCallToolResult({ content: snapshot })) {
    throw new TypeError(
      "Result composition may add only valid MCP content blocks",
    );
  }
  return {
    prepend: snapshot.slice(0, prepend.length),
    append: snapshot.slice(prepend.length),
  };
}

/**
 * Add MCP content blocks without replacing any field on the authored result.
 * Only the additions are bounded; the original result remains untouched.
 */
export function composeResultContent(
  result: CallToolResult,
  composition: ResultContentComposition,
): CallToolResult {
  const added = addedContent(composition);
  if (added.prepend.length === 0 && added.append.length === 0) return result;
  return {
    ...result,
    content: [...added.prepend, ...result.content, ...added.append],
  };
}

/** Append bounded model-facing text while preserving the authored result. */
export function appendResultText(
  result: CallToolResult,
  text: string,
): CallToolResult {
  return composeResultContent(result, {
    append: [{ type: "text", text }],
  });
}

/** Prepend bounded model-facing text while preserving the authored result. */
export function prependResultText(
  result: CallToolResult,
  text: string,
): CallToolResult {
  return composeResultContent(result, {
    prepend: [{ type: "text", text }],
  });
}

/** Return purpose-written text for an agent or person. */
export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Return exact machine-readable JSON without manufacturing a duplicate text
 * representation. Register an outputSchema on the tool that describes value.
 */
export function structuredResult<T>(value: T): CallToolResult {
  return { content: [], structuredContent: value };
}

/**
 * Return intentionally different representations for two real consumers:
 * purpose-written model-facing text and exact machine-readable JSON. Register
 * an outputSchema on the tool that describes value.
 */
export function renderResult<T>(
  value: T,
  render: (value: T) => string,
): CallToolResult {
  return {
    content: [{ type: "text", text: render(value) }],
    structuredContent: value,
  };
}

/**
 * Point at content registered through MCP resources instead of embedding a
 * large body in a tool result. Text is the concise agent-facing reading card.
 */
export function resourceResult(
  text: string,
  resource: ResourceResultLink,
): CallToolResult {
  return { content: [{ type: "text", text }, resource] };
}

/** Return a recoverable tool-level error. */
export function errorResult(
  message: string,
  nextStep?: string,
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          nextStep === undefined
            ? message
            : `${message}\n\n→ Next: ${nextStep}`,
      },
    ],
    isError: true,
  };
}
