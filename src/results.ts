import type { CallToolResult } from "@modelcontextprotocol/server";

function asStructuredContent(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

const INDENT = "  ";

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  return String(value);
}

function renderInto(lines: string[], value: unknown, depth: number): void {
  const pad = INDENT.repeat(depth);
  if (isScalar(value)) {
    lines.push(`${pad}${scalarText(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad}- (none)`);
      return;
    }
    for (const item of value) {
      if (isScalar(item)) {
        lines.push(`${pad}- ${scalarText(item)}`);
        continue;
      }
      const entries = Array.isArray(item)
        ? undefined
        : Object.entries(item as Record<string, unknown>).filter(
            ([, entryValue]) => entryValue !== undefined,
          );
      if (
        entries !== undefined &&
        entries.every(([, entryValue]) => isScalar(entryValue))
      ) {
        lines.push(
          `${pad}- ${entries
            .map(([key, entryValue]) => `${key}: ${scalarText(entryValue)}`)
            .join(" · ")}`,
        );
        continue;
      }
      lines.push(`${pad}-`);
      renderInto(lines, item, depth + 1);
    }
    return;
  }
  for (const [key, entryValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (entryValue === undefined) continue;
    if (isScalar(entryValue)) {
      lines.push(`${pad}**${key}**: ${scalarText(entryValue)}`);
    } else {
      lines.push(`${pad}**${key}**:`);
      renderInto(lines, entryValue, depth + 1);
    }
  }
}

/**
 * Render any tool payload as legible markdown: bolded keys, list rows,
 * one-line rows for flat objects inside arrays. A fallback, not a substitute
 * for a purpose-written renderer — models act on what this text says.
 */
export function toMarkdown(value: unknown): string {
  const lines: string[] = [];
  renderInto(lines, value, 0);
  return lines.join("\n");
}

/**
 * The primary result helper. Consuming models read only `content[].text`;
 * `structuredContent` is a side channel for typed clients. `render` is
 * therefore required: it produces the complete model-facing markdown for the
 * value, and the raw value rides along as structured content. End the text
 * with a next step; never leave the model at a dead end.
 */
export function renderResult<T>(
  value: T,
  render: (value: T) => string,
): CallToolResult {
  return {
    content: [{ type: "text", text: render(value) }],
    structuredContent: asStructuredContent(value),
  };
}

/**
 * Convenience result for payloads without a purpose-written renderer.
 * The model-facing text is `toMarkdown(value)` — legible by default.
 *
 * Passing `text` replaces the rendered value entirely, which hides the
 * payload from models that only read content text. If you are reaching for
 * the `text` parameter, use {@link renderResult} instead and compose a text
 * that carries the data.
 */
export function jsonResult(value: unknown, text?: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: text ?? toMarkdown(value),
      },
    ],
    structuredContent: asStructuredContent(value),
  };
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Error result. Pass `nextStep` so the model knows how to recover — an error
 * without a route is a dead end.
 */
export function errorResult(
  message: string,
  nextStep?: string,
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          nextStep === undefined ? message : `${message}\n\n→ Next: ${nextStep}`,
      },
    ],
    isError: true,
  };
}
