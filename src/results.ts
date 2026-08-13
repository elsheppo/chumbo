import type { CallToolResult } from "@modelcontextprotocol/server";

function asStructuredContent(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

export function jsonResult(value: unknown, text?: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: text ?? JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: asStructuredContent(value),
  };
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
