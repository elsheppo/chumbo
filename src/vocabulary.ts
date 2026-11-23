const DEFAULT_VOCABULARY_PAGE_SIZE = 50;
const MAX_VOCABULARY_PAGE_SIZE = 200;
const DEFAULT_VOCABULARY_MAX_PAGES = 20;
const MAX_VOCABULARY_MAX_PAGES = 100;

/**
 * Normalize to Unicode NFC, trim leading/trailing whitespace, and collapse
 * internal whitespace runs to single ASCII spaces.
 */
export function canonicalTerm(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

/**
 * Lowercase canonical key for case- and spacing-insensitive identity comparison
 * without fuzzy or punctuation merging (`"case study"` !== `"case-study"`).
 */
export function canonicalTermKey(value: string): string {
  return canonicalTerm(value).toLowerCase();
}

export class VocabularyIncompleteError extends Error {
  readonly code = "vocabulary_incomplete" as const;
  readonly prefix: string;
  readonly pagesScanned: number;

  constructor(prefix: string, pagesScanned: number) {
    super(
      `Existing vocabulary for prefix "${prefix}" exceeded ${pagesScanned} pages and could not be verified completely.`,
    );
    this.name = "VocabularyIncompleteError";
    this.prefix = prefix;
    this.pagesScanned = pagesScanned;
  }
}

export interface VocabularyLookupPage {
  readonly items: readonly string[];
  readonly nextCursor?: string | null;
}

export interface ResolveCanonicalVocabularyOptions {
  readonly values: readonly string[];
  /** Paginated lookup under the current caller's RLS-scoped client. */
  listPage(input: {
    readonly prefix: string;
    readonly cursor?: string;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): VocabularyLookupPage | Promise<VocabularyLookupPage>;
  /** Page size passed to `listPage` (1..200, default `50`). */
  readonly pageSize?: number;
  /** Maximum pages scanned per prefix before failing closed (1..100, default `20`). */
  readonly maxPages?: number;
  /** Extract server-side prefix query from a `canonicalTermKey` (defaults to `key.split(" ")[0]!`). */
  readonly prefixFor?: (canonicalKey: string) => string;
  /** Format a verified-new term when no existing item matches `canonicalTermKey` (defaults to `(_, key) => key`). */
  readonly formatNew?: (canonicalText: string, canonicalKey: string) => string;
  readonly signal?: AbortSignal;
}

function boundedPositiveInt(
  value: number | undefined,
  defaultValue: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? defaultValue;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new RangeError(`${label} must be an integer from 1 to ${maximum}`);
  }
  return resolved;
}

/**
 * Resolve candidate tag/label/category values against an application's paginated
 * vocabulary so existing stored spellings are reused verbatim while verified-new
 * terms normalize deterministically. Fails closed with `VocabularyIncompleteError`
 * if a prefix lookup remains truncated after `maxPages` or stalls on a cursor.
 */
export async function resolveCanonicalVocabulary(
  options: ResolveCanonicalVocabularyOptions,
): Promise<string[]> {
  const pageSize = boundedPositiveInt(
    options.pageSize,
    DEFAULT_VOCABULARY_PAGE_SIZE,
    MAX_VOCABULARY_PAGE_SIZE,
    "Vocabulary pageSize",
  );
  const maxPages = boundedPositiveInt(
    options.maxPages,
    DEFAULT_VOCABULARY_MAX_PAGES,
    MAX_VOCABULARY_MAX_PAGES,
    "Vocabulary maxPages",
  );
  const prefixFor =
    options.prefixFor ??
    ((canonicalKey: string) => canonicalKey.split(" ")[0]!);
  const formatNew =
    options.formatNew ?? ((_canonicalText: string, key: string) => key);

  const prefixCache = new Map<string, string[]>();
  const resolved = new Map<string, string>();

  for (const rawValue of options.values) {
    const normalizedText = canonicalTerm(rawValue);
    const key = normalizedText.toLowerCase();
    if (!key || resolved.has(key)) continue;

    const prefix = prefixFor(key);
    let candidates = prefixCache.get(prefix);
    if (!candidates) {
      candidates = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      let pagesScanned = 0;

      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        options.signal?.throwIfAborted();
        const page = await options.listPage({
          prefix,
          limit: pageSize,
          ...(cursor !== undefined ? { cursor } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        pagesScanned += 1;
        candidates.push(...page.items);

        const next =
          typeof page.nextCursor === "string" && page.nextCursor.length > 0
            ? page.nextCursor
            : undefined;
        if (!next) {
          cursor = undefined;
          break;
        }
        if (seenCursors.has(next)) {
          throw new VocabularyIncompleteError(prefix, pagesScanned);
        }
        seenCursors.add(next);
        cursor = next;
      }

      if (cursor !== undefined) {
        throw new VocabularyIncompleteError(prefix, pagesScanned);
      }
      prefixCache.set(prefix, candidates);
    }

    const existingMatch = candidates.find(
      (candidate) => canonicalTermKey(candidate) === key,
    );
    resolved.set(key, existingMatch ?? formatNew(normalizedText, key));
  }

  return [...resolved.values()];
}
