import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url).pathname;

async function metadataFiles(
  directory: string,
  filename: string,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      files.push(...(await metadataFiles(path, filename)));
    else if (entry.name === filename) files.push(path);
  }

  return files;
}

describe("reference content", () => {
  it("resolves every pattern example to a published example document", async () => {
    const patternFiles = await metadataFiles(
      join(root, "docs/patterns"),
      "pattern.json",
    );
    const exampleFiles = await metadataFiles(
      join(root, "examples"),
      "example.json",
    );
    const exampleSlugs = new Set(
      await Promise.all(
        exampleFiles.map(async (file) => {
          const document = JSON.parse(await readFile(file, "utf8")) as {
            slug: string;
          };
          return document.slug;
        }),
      ),
    );

    for (const file of patternFiles) {
      const pattern = JSON.parse(await readFile(file, "utf8")) as {
        example?: string;
        slug: string;
      };

      if (pattern.example) {
        expect(
          exampleSlugs,
          `${pattern.slug} references ${pattern.example}`,
        ).toContain(pattern.example);
      }
    }
  });
});
