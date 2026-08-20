import type {
  CallToolResult,
  ResourceLink,
} from "@modelcontextprotocol/server";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ResourceResultLink = ResourceLink;

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
