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
  const text = String(value);
  return text.length === 0 ? "(empty)" : text;
}

function scalarLines(value: unknown): string[] {
  return scalarText(value).split(/\r?\n/);
}

function renderScalar(
  lines: string[],
  value: unknown,
  firstPrefix: string,
  continuationPrefix: string,
): void {
  const [first = "", ...rest] = scalarLines(value);
  lines.push(`${firstPrefix}${first}`);
  for (const line of rest) lines.push(`${continuationPrefix}${line}`);
}

function visibleEntries(value: object): Array<[string, unknown]> {
  return Object.entries(value).filter(
    ([, entryValue]) => entryValue !== undefined,
  );
}

function isSingleLineScalar(value: unknown): boolean {
  return isScalar(value) && scalarLines(value).length === 1;
}

function renderInto(lines: string[], value: unknown, depth: number): void {
  const pad = INDENT.repeat(depth);
  if (isScalar(value)) {
    renderScalar(lines, value, pad, pad);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad}- (none)`);
      return;
    }
    for (const item of value) {
      if (isScalar(item)) {
        renderScalar(lines, item, `${pad}- `, `${pad}${INDENT}`);
        continue;
      }
      const entries = Array.isArray(item)
        ? undefined
        : visibleEntries(item as Record<string, unknown>);
      if (entries?.length === 0) {
        lines.push(`${pad}- (none)`);
        continue;
      }
      if (
        entries !== undefined &&
        entries.every(([, entryValue]) => isSingleLineScalar(entryValue))
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
  const entries = visibleEntries(value as Record<string, unknown>);
  if (entries.length === 0) {
    lines.push(`${pad}(none)`);
    return;
  }
  for (const [key, entryValue] of entries) {
    if (isScalar(entryValue)) {
      if (isSingleLineScalar(entryValue)) {
        lines.push(`${pad}**${key}**: ${scalarText(entryValue)}`);
      } else {
        lines.push(`${pad}**${key}**:`);
        renderScalar(lines, entryValue, `${pad}${INDENT}`, `${pad}${INDENT}`);
      }
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
 * The primary result helper. `content[].text` is the portable model-facing
 * lane; some clients do not surface `structuredContent` to the model. `render`
 * is therefore required: it produces complete standalone markdown for the
 * value, and the raw value rides along as structured content. End the text with
 * a next step; never leave the model at a dead end.
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
          nextStep === undefined
            ? message
            : `${message}\n\n→ Next: ${nextStep}`,
      },
    ],
    isError: true,
  };
}
