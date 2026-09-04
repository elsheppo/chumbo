import type { CallToolResult } from "@modelcontextprotocol/server";

export const collectionBudgetKey = "io.chumbo/collectionMaxBytes";

export function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function assertCollectionBudget(result: CallToolResult): void {
  const budget = result._meta?.[collectionBudgetKey];
  if (typeof budget === "number" && encodedBytes(result) > budget) {
    throw new RangeError(
      `Collection result exceeds its ${budget} encoded-byte budget`,
    );
  }
}
