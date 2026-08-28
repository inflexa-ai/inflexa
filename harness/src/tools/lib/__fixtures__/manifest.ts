/**
 * The contract of the `manifest.json` of one fixture directory.
 *
 * A golden fixture is a real payload of a provider, and it is only evidence while
 * a reader can get the same payload again. The manifest records how each fixture
 * was captured. `scripts/refresh-fixtures.ts` replays the manifest against the
 * live provider and diffs the answer against the stored file.
 *
 * The manifest is a map. Each key is a file name inside the same directory, and
 * each value is the capture record of that file.
 */

import { z } from "zod";

/** `YYYY-MM-DD`. The manifest records the date of the capture, not a timestamp. */
const CAPTURED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The capture record of one fixture file. */
export interface FixtureManifestEntry {
    /** The request URL, with no query string when `params` carries the query. */
    url: string;
    /**
     * The query parameters of the request. The refresh script appends them to `url`,
     * for a POST as well, because a POST route can still read a query parameter.
     */
    params?: Record<string, string>;
    /**
     * The HTTP method of the capture. The default is `GET`. A GraphQL endpoint
     * answers a GET with an error, thus a GraphQL capture records `POST` here and
     * carries its document in `body`.
     */
    method?: "GET" | "POST";
    /**
     * The request body, as the exact text that the client sends. The refresh script
     * sends it unchanged, thus a GraphQL replay reaches the same document and the
     * same variables as the capture did.
     */
    body?: string;
    /**
     * The request headers of the capture. A provider answers a different format
     * without them: HGNC serves XML unless the request asks for `application/json`.
     */
    headers?: Record<string, string>;
    /**
     * The fixture holds an excerpt of the live body, not the whole of it. Such a
     * file can never match a replay, thus the script reports it as skipped instead
     * of as drift. An excerpt keeps each observed row variant, and the live list
     * grows, thus a row-count difference says nothing about the contract.
     */
    replay?: false;
    /** The date of the capture, as `YYYY-MM-DD`. `--write` sets it to the date of the rewrite. */
    capturedAt: string;
    /**
     * The JSON paths that the refresh diff skips, for example `header.version` or
     * `results.*.updatedAt`. A `*` segment matches one array index or one key, and
     * an entry covers each path under it. A volatile field, such as a timestamp or
     * a total count, changes on every replay, thus only real contract drift is
     * reported.
     */
    ignorePaths?: string[];
    /**
     * The file holds a published schema of the provider, not a payload. The refresh
     * script compares such a file as raw text, because a published schema can be
     * YAML or XSD and a JSON diff does not apply to it.
     */
    oracle?: true;
}

/** The `manifest.json` of one fixture directory: a file name maps to its capture record. */
export type FixtureManifest = Record<string, FixtureManifestEntry>;

/** The parser of one capture record. The refresh script reads `manifest.json` through it. */
export const FixtureManifestEntrySchema = z.object({
    url: z.string(),
    params: z.record(z.string(), z.string()).optional(),
    method: z.enum(["GET", "POST"]).optional(),
    body: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    replay: z.literal(false).optional(),
    capturedAt: z.string().regex(CAPTURED_AT_PATTERN),
    ignorePaths: z.array(z.string()).optional(),
    oracle: z.literal(true).optional(),
});

/** The parser of a whole `manifest.json`. */
export const FixtureManifestSchema = z.record(z.string(), FixtureManifestEntrySchema);

/** A type that is not `true` breaks the constraint, thus the typecheck reports the drift. */
type Assert<T extends true> = T;

// The declared interface and the parser are one contract. A drift between the two
// fails the typecheck here, thus the script and the fixture authors cannot disagree.
type _ManifestEntryContract = [
    Assert<FixtureManifestEntry extends z.infer<typeof FixtureManifestEntrySchema> ? true : false>,
    Assert<z.infer<typeof FixtureManifestEntrySchema> extends FixtureManifestEntry ? true : false>,
];
