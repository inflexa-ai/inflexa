/**
 * Replay the golden-fixture manifests against the live providers, and report the drift.
 *
 * ```
 * bun scripts/refresh-fixtures.ts [--write] [provider...]
 * ```
 *
 * A golden fixture pins the last verified truth of an endpoint. A provider changes its contract without a
 * notice, thus the pin goes stale in silence. This script makes the staleness visible: it reads each
 * `src/tools/lib/__fixtures__/<provider>/manifest.json`, requests each recorded URL again, and diffs the
 * answer against the stored file. A path that the entry names in `ignorePaths` is skipped, thus a
 * timestamp or a total count does not report as drift.
 *
 * An entry records the method, the body, and the headers of its capture, thus a GraphQL POST replays as a
 * POST and HGNC answers JSON again. An entry that carries `replay: false` holds an excerpt of the live
 * body. Such a file can never match a replay, thus the script reports it as skipped and not as drift.
 *
 * The default run changes no file, and it exits non-zero when there is drift. `--write` rewrites each
 * drifted fixture and sets the `capturedAt` of its entry to the date of the run. A positional argument
 * limits the run to the named provider directories.
 *
 * The replay is polite, because these are free public endpoints of research institutes. The requests run
 * one at a time, with a gap of at least 300 ms, and a request to an NCBI host waits 334 ms, which is the
 * cap of 3 requests each second.
 *
 * The script runs on demand, never in CI. As a result the offline test suite stays offline.
 *
 * The script sits outside `src/`, thus the build never emits it into `dist/`.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sleep } from "../src/lib/async-utils.js";
import { FixtureManifestSchema, type FixtureManifest, type FixtureManifestEntry } from "../src/tools/lib/__fixtures__/manifest.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "tools", "lib", "__fixtures__");

const MIN_GAP_MS = 300;
/** 3 requests each second is the keyless NCBI cap. */
const NCBI_GAP_MS = 334;
const NCBI_HOST_SUFFIX = "ncbi.nlm.nih.gov";
const REQUEST_TIMEOUT_MS = 60_000;
/** A long report hides the first difference, which is the one that a reader acts on. */
const MAX_REPORTED_DIFFERENCES = 20;
const MAX_RENDERED_VALUE = 80;

/** One difference between the stored fixture and the live answer. */
interface Difference {
    path: string;
    stored: string;
    live: string;
}

/** The outcome of one replayed fixture. */
type Outcome =
    | { kind: "same" }
    | { kind: "skipped" }
    | { kind: "missing"; body: string }
    | { kind: "drift"; differences: Difference[]; body: string }
    | { kind: "failed"; reason: string };

let lastRequestAt = 0;

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const flags = argv.filter((arg) => arg.startsWith("--"));
    const selected = argv.filter((arg) => !arg.startsWith("--"));

    const unknown = flags.filter((flag) => flag !== "--write");
    if (unknown.length > 0) {
        console.error(`refresh-fixtures: unknown flag ${unknown.join(", ")}`);
        console.error("usage: bun scripts/refresh-fixtures.ts [--write] [provider...]");
        process.exitCode = 2;
        return;
    }
    const write = flags.includes("--write");

    const providers = await listProviders(selected);
    if (providers.length === 0) {
        console.error("refresh-fixtures: no fixture directory carries a manifest.json");
        process.exitCode = 2;
        return;
    }

    let driftCount = 0;
    let failureCount = 0;

    for (const provider of providers) {
        const manifestPath = join(FIXTURES_DIR, provider, "manifest.json");
        const manifest = await readManifest(provider, manifestPath);
        if (manifest === null) {
            failureCount += 1;
            continue;
        }

        const rewritten: string[] = [];
        for (const file of Object.keys(manifest).sort()) {
            const entry = manifest[file];
            const outcome = await replay(provider, file, entry);

            switch (outcome.kind) {
                case "same":
                    console.log(`${provider}/${file}: no drift`);
                    break;
                case "skipped":
                    console.log(`${provider}/${file}: skipped (excerpt)`);
                    break;
                case "failed":
                    console.error(`${provider}/${file}: the replay failed — ${outcome.reason}`);
                    failureCount += 1;
                    break;
                case "missing":
                    driftCount += 1;
                    console.log(`${provider}/${file}: the fixture file is absent`);
                    if (write) {
                        await writeFile(join(FIXTURES_DIR, provider, file), outcome.body, "utf8");
                        rewritten.push(file);
                    }
                    break;
                case "drift":
                    driftCount += 1;
                    reportDrift(`${provider}/${file}`, outcome.differences);
                    if (write) {
                        await writeFile(join(FIXTURES_DIR, provider, file), outcome.body, "utf8");
                        rewritten.push(file);
                    }
                    break;
            }
        }

        if (write && rewritten.length > 0) {
            const today = new Date().toISOString().slice(0, 10);
            for (const file of rewritten) manifest[file].capturedAt = today;
            await writeFile(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`, "utf8");
            console.log(`${provider}/manifest.json: ${rewritten.length} entries rewritten, capturedAt ${today}`);
        }
    }

    if (failureCount > 0) {
        console.error(`refresh-fixtures: ${failureCount} replays failed`);
        process.exitCode = 1;
        return;
    }
    if (driftCount > 0 && !write) {
        console.error(`refresh-fixtures: ${driftCount} fixtures drifted. Run again with --write to accept the live payloads.`);
        process.exitCode = 1;
        return;
    }
    console.log(write ? "refresh-fixtures: done" : "refresh-fixtures: every fixture matches its provider");
}

/** Find each fixture directory that carries a manifest, limited to the selected names. */
async function listProviders(selected: string[]): Promise<string[]> {
    const entries = await readdir(FIXTURES_DIR, { withFileTypes: true });
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => selected.length === 0 || selected.includes(name))
        .filter((name) => existsSync(join(FIXTURES_DIR, name, "manifest.json")))
        .sort();
}

/** Read and validate one `manifest.json`. A file that breaks the contract gives `null`. */
async function readManifest(provider: string, path: string): Promise<FixtureManifest | null> {
    let raw: unknown;
    try {
        raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (error) {
        // A missing or malformed file is a normal condition of an edit in progress. Report the cause and
        // continue with the other providers, because a stack trace here hides the drift report.
        reject(provider, [error instanceof Error ? error.message : String(error)]);
        return null;
    }

    const parsed = FixtureManifestSchema.safeParse(raw);
    if (!parsed.success) {
        reject(
            provider,
            parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        );
        return null;
    }
    return parsed.data;
}

/** Report a manifest that the script cannot use. The label comes first, thus a multi-provider run stays readable. */
function reject(provider: string, details: string[]): void {
    console.error(`${provider}/manifest.json: the file does not match the manifest contract`);
    for (const detail of details) console.error(`  ${detail}`);
}

/** Request one entry again and compare the answer against the stored file. */
async function replay(provider: string, file: string, entry: FixtureManifestEntry): Promise<Outcome> {
    // An excerpt keeps one row of each observed variant, thus the live list is
    // longer by design. A diff would report that length as drift on every run, and
    // a report that is always red hides the one contract break that matters.
    if (entry.replay === false) return { kind: "skipped" };

    const url = buildUrl(entry);
    let body: string;
    try {
        const response = await politeFetch(url, entry);
        if (!response.ok) return { kind: "failed", reason: `HTTP ${response.status} from ${url}` };
        body = await response.text();
    } catch (error) {
        return { kind: "failed", reason: `${error instanceof Error ? error.message : String(error)} (${url})` };
    }

    const path = join(FIXTURES_DIR, provider, file);
    // An oracle entry holds a published schema, which can be YAML or XSD. A JSON diff does not apply to
    // it, thus the comparison is over the raw text.
    const normalized = entry.oracle ? body : `${JSON.stringify(safeJson(body), null, 4)}\n`;
    if (!existsSync(path)) return { kind: "missing", body: normalized };

    const stored = await readFile(path, "utf8");
    if (entry.oracle) {
        if (stored === body) return { kind: "same" };
        return { kind: "drift", differences: [{ path: "$", stored: `${stored.length} bytes`, live: `${body.length} bytes` }], body: normalized };
    }

    const ignorePaths = (entry.ignorePaths ?? []).map((ignore) => ignore.split("."));
    const differences = diffJson(safeJson(stored), safeJson(body), ignorePaths, [], []);
    if (differences.length === 0) return { kind: "same" };
    return { kind: "drift", differences, body: normalized };
}

function buildUrl(entry: FixtureManifestEntry): string {
    if (!entry.params) return entry.url;
    const url = new URL(entry.url);
    for (const [key, value] of Object.entries(entry.params)) url.searchParams.set(key, value);
    return url.toString();
}

/**
 * Request one URL, after the pacing gap of its host.
 *
 * Each caller awaits this function, thus the requests run one at a time. The gap is measured from the end
 * of the previous request. As a result the idle interval between two requests is at least the gap, and the
 * request rate stays under the cap of the provider.
 *
 * The method, the body, and the headers come from the entry. A provider answers a different format, or no
 * data at all, when the replay drops them: a GraphQL endpoint rejects a GET, and HGNC serves XML without an
 * `Accept` header.
 */
async function politeFetch(url: string, entry: FixtureManifestEntry): Promise<Response> {
    const gap = new URL(url).hostname.endsWith(NCBI_HOST_SUFFIX) ? NCBI_GAP_MS : MIN_GAP_MS;
    const wait = lastRequestAt + gap - Date.now();
    if (wait > 0) await sleep(wait);
    const init: RequestInit = {
        method: entry.method ?? "GET",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(entry.headers ? { headers: entry.headers } : {}),
        ...(entry.body === undefined ? {} : { body: entry.body }),
    };
    try {
        return await fetch(url, init);
    } finally {
        // A request that failed still reached the provider, thus it paces the next one.
        lastRequestAt = Date.now();
    }
}

/** Parse JSON text. A body that is not JSON stays a string, thus the diff reports it instead of throwing. */
function safeJson(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return text;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Does an ignore path cover this path? A `*` segment matches one segment, and an entry covers what is under it. */
function isIgnored(path: string[], ignorePaths: string[][]): boolean {
    for (const ignore of ignorePaths) {
        if (ignore.length > path.length) continue;
        let matches = true;
        for (let i = 0; i < ignore.length; i++) {
            if (ignore[i] !== "*" && ignore[i] !== path[i]) {
                matches = false;
                break;
            }
        }
        if (matches) return true;
    }
    return false;
}

/**
 * Compare the stored value against the live value, and collect each difference.
 *
 * A length change of an array is reported one time, and the walk then covers the common indices only. A
 * per-index report of an appended row buries the type break that a reader looks for.
 */
function diffJson(stored: unknown, live: unknown, ignorePaths: string[][], path: string[], out: Difference[]): Difference[] {
    if (isIgnored(path, ignorePaths)) return out;

    if (Array.isArray(stored) && Array.isArray(live)) {
        if (stored.length !== live.length) {
            out.push({ path: `${renderPath(path)}[]`, stored: `${stored.length} items`, live: `${live.length} items` });
        }
        const common = Math.min(stored.length, live.length);
        for (let i = 0; i < common; i++) diffJson(stored[i], live[i], ignorePaths, [...path, String(i)], out);
        return out;
    }

    if (isRecord(stored) && isRecord(live)) {
        const keys = [...new Set([...Object.keys(stored), ...Object.keys(live)])].sort();
        for (const key of keys) diffJson(stored[key], live[key], ignorePaths, [...path, key], out);
        return out;
    }

    if (!Object.is(stored, live)) {
        out.push({ path: renderPath(path), stored: renderValue(stored), live: renderValue(live) });
    }
    return out;
}

function renderPath(path: string[]): string {
    return path.length === 0 ? "$" : path.join(".");
}

function renderValue(value: unknown): string {
    if (value === undefined) return "(absent)";
    const text = JSON.stringify(value) ?? String(value);
    return text.length > MAX_RENDERED_VALUE ? `${text.slice(0, MAX_RENDERED_VALUE)}…` : text;
}

function reportDrift(label: string, differences: Difference[]): void {
    console.log(`${label}: ${differences.length} differences`);
    for (const difference of differences.slice(0, MAX_REPORTED_DIFFERENCES)) {
        console.log(`  ${difference.path}: stored ${difference.stored} -> live ${difference.live}`);
    }
    const remaining = differences.length - MAX_REPORTED_DIFFERENCES;
    if (remaining > 0) console.log(`  (+${remaining} more)`);
}

await main();
