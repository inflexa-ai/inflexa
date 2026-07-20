import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { testRender } from "@opentui/solid";

import { env } from "../lib/env.ts";
import { ConfigApp } from "./app_config.tsx";
import { dialogClear, dialogIsOpen } from "./components/dialog/dialog_host.tsx";

// The embedding-backend wiring drives the REAL ConfigApp (standalone: it installs its own keymap root
// and DialogOverlay) through the keyboard bus, covering the async/stateful dialog chains that unit tests
// can't reach: openEmbeddingPicker → startBackendFlow → the api-key fetch chain (SelectDialog on success,
// free-text prompt on failure, dead-flow guard on supersede) and the custom-GGUF FilePicker flow. Each
// case asserts the PERSISTED config block (via `s` save + reading env.configPath in the XDG test sandbox),
// which is the only place the "omit dimensions at the default width" rule is observable — the summary row
// always prints a fallback width, so the absence of the key never shows there.

// Captured ONCE so the per-test stub is always restored regardless of which test set it (the api_models
// test's idiom). The XDG sandbox (test preload) gives every ConfigApp an isolated, defaults-only config.
const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
    dialogClear();
    // Leave the shared sandbox config pristine: a saved api-key/local block here would otherwise seed the
    // next test's (and other files') ConfigApp with a non-default embedding backend.
    rmSync(env.configPath, { force: true });
});

type Setup = Awaited<ReturnType<typeof testRender>>;

// A lone ESC byte is an ambiguous escape-sequence prefix (opentui's StdinParser holds it ~20ms before
// flushing), and the api-key probe resolves across microtasks — settle on a real clock, then render twice,
// matching the dialog-host render tests.
async function settle(setup: Setup): Promise<void> {
    await new Promise((r) => setTimeout(r, 35));
    await setup.renderOnce();
    await setup.renderOnce();
}

function frame(setup: Setup): string {
    return setup
        .captureCharFrame()
        .split("\n")
        .map((l) => l.trimEnd())
        .join("\n");
}

/** The `embedding` block as it was actually written to disk — the ground truth for the Item A rule. */
function persistedEmbedding(): Record<string, unknown> {
    // The on-disk config is validated JSON the ConfigApp just wrote; reading it raw (not through readConfig)
    // keeps the assertion honest about which keys are literally present.
    const parsed = JSON.parse(readFileSync(env.configPath, "utf8")) as { embedding?: Record<string, unknown> };
    return parsed.embedding ?? {};
}

// Embedding is the last of the nine sections (telemetry, theme, runtime, the five postgres fields, then
// embedding), so eight arrow-downs from the fixed top origin land on it.
async function focusEmbeddingSection(setup: Setup): Promise<void> {
    for (let i = 0; i < 8; i++) setup.mockInput.pressArrow("down");
    await settle(setup);
}

/** From the focused embedding row, open the backend picker and choose the item at `downs` (0-indexed). */
async function chooseBackend(setup: Setup, downs: number): Promise<void> {
    setup.mockInput.pressEnter(); // Enter on the embedding section opens the "Embedding backend" picker
    await settle(setup);
    for (let i = 0; i < downs; i++) setup.mockInput.pressArrow("down");
    setup.mockInput.pressEnter();
    await settle(setup);
}

// The picker order is builtin(0), custom(1), api-key(2), off(3).
const API_KEY_CHOICE = 2;
const CUSTOM_GGUF_CHOICE = 1;

/** Enter the api key, then accept the seeded default base URL — which fires the model probe. */
async function submitKeyAndDefaultBaseUrl(setup: Setup, key: string): Promise<void> {
    await setup.mockInput.typeText(key);
    setup.mockInput.pressEnter();
    await settle(setup);
    setup.mockInput.pressEnter(); // accept the pre-seeded DEFAULT_API_BASE_URL
    await settle(setup);
}

/** Replace a prompt's seeded value (cursor sits at its end) with `next`, then submit. */
async function replaceAndSubmit(setup: Setup, seededLength: number, next: string): Promise<void> {
    for (let i = 0; i < seededLength; i++) setup.mockInput.pressBackspace();
    await setup.mockInput.typeText(next);
    await settle(setup);
    setup.mockInput.pressEnter();
    await settle(setup);
}

/**
 * From the FilePicker rooted at the real home, filter to the fixture dir, descend into it, select the
 * lone `my-model.gguf`, and confirm the batch — the deterministic route to a controlled file under a root
 * the flow hardcodes. Uses the filter (not blind arrow-walking) so a crowded real home never shifts it.
 */
async function browseToFixtureGguf(setup: Setup, fixtureName: string): Promise<void> {
    setup.mockInput.pressKey("i"); // focus the filter (INSERT)
    await setup.mockInput.typeText(fixtureName); // narrow the home listing to the fixture dir alone
    await settle(setup);
    setup.mockInput.pressEscape(); // blur to NORMAL (filter text persists; the dir stays the sole match)
    await settle(setup);
    setup.mockInput.pressArrow("right"); // descend into the fixture dir (resets the filter)
    await settle(setup);
    setup.mockInput.pressArrow("down"); // .. → my-model.gguf
    setup.mockInput.pressKey(" "); // select the file
    setup.mockInput.pressEnter(); // confirm the batch
}

describe("ConfigApp embedding backend wiring (rendered, real keyboard bus)", () => {
    test("api-key happy path: fetched model picker, a 1536 width omits dimensions", async () => {
        globalThis.fetch = resolvingFetch({
            data: [{ id: "gpt-4o" }, { id: "text-embedding-3-large" }, { id: "text-embedding-3-small" }],
        });
        const setup = await testRender(() => <ConfigApp />, { width: 100, height: 44 });
        try {
            await settle(setup);
            await focusEmbeddingSection(setup);
            await chooseBackend(setup, API_KEY_CHOICE);
            expect(frame(setup)).toContain("embedding.apiKey");

            await submitKeyAndDefaultBaseUrl(setup, "sk-test-123");

            // The listing resolved into the model picker, embedding-only and sorted; the chat model dropped.
            expect(frame(setup)).toContain("Embedding model");
            expect(frame(setup)).toContain("text-embedding-3-small");
            expect(frame(setup)).not.toContain("gpt-4o");

            setup.mockInput.pressEnter(); // pick the first row (sorted: text-embedding-3-large)
            await settle(setup);
            expect(frame(setup)).toContain("Vector dimensions");

            setup.mockInput.pressEnter(); // accept the seeded 1536 default
            await settle(setup);

            // The summary row switched from the default "off" to the api-key backend.
            expect(frame(setup)).toContain("embedding: api-key — text-embedding-3-large (1536-dim)");

            setup.mockInput.pressKey("s"); // save
            await settle(setup);
            // Item A: at the 1536 default the key is omitted, exactly as the local branches drop 384.
            expect(persistedEmbedding()).toEqual({
                mode: "api-key",
                apiKey: "sk-test-123",
                baseURL: "https://api.openai.com/v1",
                model: "text-embedding-3-large",
            });
        } finally {
            setup.renderer.destroy();
        }
    });

    test("api-key happy path: a non-default width records dimensions", async () => {
        globalThis.fetch = resolvingFetch({ data: [{ id: "text-embedding-3-small" }] });
        const setup = await testRender(() => <ConfigApp />, { width: 100, height: 44 });
        try {
            await settle(setup);
            await focusEmbeddingSection(setup);
            await chooseBackend(setup, API_KEY_CHOICE);
            await submitKeyAndDefaultBaseUrl(setup, "sk-abc");

            expect(frame(setup)).toContain("Embedding model");
            setup.mockInput.pressEnter(); // the sole embedding id
            await settle(setup);
            expect(frame(setup)).toContain("Vector dimensions");

            await replaceAndSubmit(setup, "1536".length, "3072"); // width differs from the 1536 default

            expect(frame(setup)).toContain("embedding: api-key — text-embedding-3-small (3072-dim)");

            setup.mockInput.pressKey("s");
            await settle(setup);
            expect(persistedEmbedding()).toEqual({
                mode: "api-key",
                apiKey: "sk-abc",
                baseURL: "https://api.openai.com/v1",
                model: "text-embedding-3-small",
                dimensions: 3072,
            });
        } finally {
            setup.renderer.destroy();
        }
    });

    test("fetch failure: warn notice + free-text model prompt still lands the block", async () => {
        globalThis.fetch = resolvingFetch({ error: "unauthorized" }, 401); // non-2xx → listing fails
        const setup = await testRender(() => <ConfigApp />, { width: 100, height: 44 });
        try {
            await settle(setup);
            await focusEmbeddingSection(setup);
            await chooseBackend(setup, API_KEY_CHOICE);
            await submitKeyAndDefaultBaseUrl(setup, "sk-x");

            // Every listing failure degrades identically: a warn notice, then a free-text prompt — NOT the
            // SelectDialog. `embedding.model` (the prompt title) is distinct from `Embedding model` (the picker).
            expect(frame(setup)).toContain("Could not list models");
            expect(frame(setup)).toContain("embedding.model");
            expect(frame(setup)).not.toContain("Embedding model");

            await setup.mockInput.typeText("my-own-embedder");
            setup.mockInput.pressEnter();
            await settle(setup);
            expect(frame(setup)).toContain("Vector dimensions");

            setup.mockInput.pressEnter(); // accept 1536
            await settle(setup);

            setup.mockInput.pressKey("s");
            await settle(setup);
            expect(persistedEmbedding()).toEqual({
                mode: "api-key",
                apiKey: "sk-x",
                baseURL: "https://api.openai.com/v1",
                model: "my-own-embedder",
            });
        } finally {
            setup.renderer.destroy();
        }
    });

    test("custom GGUF: a 384 width omits dimensions; a non-384 width records it", async () => {
        // openCustomGgufFlow roots the FilePicker at homedir() with no injection seam, and Bun caches
        // os.homedir() at process start (a mid-test $HOME override does NOT move it — verified), so the
        // only way to drive the REAL picker is to seed a fixture UNDER the real home and browse to it. The
        // dir is uniquely named and reaped in `finally`. realpath so the picker's canonical value space
        // matches (the onConfirm path is resolve(canonical cwd, name)). No fetch — the flow is fully local.
        const fixture = realpathSync(mkdtempSync(join(homedir(), "inflexa-gguf-render-test-")));
        const fixtureName = basename(fixture);
        writeFileSync(join(fixture, "my-model.gguf"), "x");
        const modelPath = join(fixture, "my-model.gguf");
        const setup = await testRender(() => <ConfigApp />, { width: 100, height: 44 });
        try {
            await settle(setup);
            await focusEmbeddingSection(setup);

            // --- 384 (the built-in width) → dimensions omitted ---
            await chooseBackend(setup, CUSTOM_GGUF_CHOICE);
            expect(frame(setup)).toContain("Select input files"); // the FilePicker title
            await browseToFixtureGguf(setup, fixtureName);
            await settle(setup);
            expect(frame(setup)).toContain("Vector dimensions");

            setup.mockInput.pressEnter(); // accept the seeded 384 default
            await settle(setup);
            setup.mockInput.pressKey("s");
            await settle(setup);
            const at384 = persistedEmbedding();
            expect(at384).toEqual({ mode: "local", modelPath });
            expect(at384.dimensions).toBeUndefined();

            // --- a non-384 width → dimensions recorded ---
            await chooseBackend(setup, CUSTOM_GGUF_CHOICE);
            await browseToFixtureGguf(setup, fixtureName);
            await settle(setup);
            expect(frame(setup)).toContain("Vector dimensions");

            await replaceAndSubmit(setup, "384".length, "768");
            setup.mockInput.pressKey("s");
            await settle(setup);
            expect(persistedEmbedding()).toEqual({ mode: "local", modelPath, dimensions: 768 });
        } finally {
            rmSync(fixture, { recursive: true, force: true });
            setup.renderer.destroy();
        }
    });

    test("dead-flow guard: a superseded probe's late resolve pushes no dialog and changes no notice", async () => {
        const calls = installControllableFetch();
        const setup = await testRender(() => <ConfigApp />, { width: 100, height: 44 });
        try {
            await settle(setup);
            await focusEmbeddingSection(setup);

            // First probe: fetch #1 is held pending, so the flow parks on the "Fetching models…" notice with
            // no model picker yet.
            await chooseBackend(setup, API_KEY_CHOICE);
            await submitKeyAndDefaultBaseUrl(setup, "sk-one");
            expect(calls.length).toBe(1);
            expect(frame(setup)).toContain("Fetching models");
            expect(dialogIsOpen()).toBe(false);

            // Re-enter the flow (embedding row is still focused): probe #2 aborts and supersedes #1, taking
            // over the tracked controller.
            await chooseBackend(setup, API_KEY_CHOICE);
            await submitKeyAndDefaultBaseUrl(setup, "sk-two");
            expect(calls.length).toBe(2);

            // The stale probe resolves LATE. Its continuation sees the controller mismatch and runs nothing —
            // no SelectDialog, no notice change.
            calls[0]!.resolve({ data: [{ id: "text-embedding-3-small" }] });
            await settle(setup);
            expect(dialogIsOpen()).toBe(false);
            expect(frame(setup)).not.toContain("Embedding model");
            expect(frame(setup)).toContain("Fetching models");

            // The live probe still completes normally — the guard did not break the happy path.
            calls[1]!.resolve({ data: [{ id: "text-embedding-3-large" }] });
            await settle(setup);
            expect(dialogIsOpen()).toBe(true);
            expect(frame(setup)).toContain("Embedding model");
            expect(frame(setup)).toContain("text-embedding-3-large");
        } finally {
            setup.renderer.destroy();
        }
    });
});

/** A fetch that resolves immediately with `body` as JSON at `status` — the api_models test's stub shape. */
function resolvingFetch(body: unknown, status = 200): typeof globalThis.fetch {
    // Test-only replacement of the global fetch: the recorder is narrower than fetch's overloaded signature;
    // the cast is sound because afterEach restores the captured real fetch.
    return (() =>
        Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))) as unknown as typeof globalThis.fetch;
}

/** One in-flight probe: its URL plus the resolve/reject the test drives manually. */
type ProbeCall = {
    url: string;
    resolve: (body: unknown, status?: number) => void;
    reject: (reason?: unknown) => void;
};

/**
 * Install a fetch that never settles on its own: each call parks a pending promise and records its
 * resolve/reject so the test settles probes on its own schedule — the mechanism for the superseded-flow
 * guard, which hinges on a probe resolving AFTER a newer one replaced it.
 */
function installControllableFetch(): ProbeCall[] {
    const calls: ProbeCall[] = [];
    // Test-only fetch replacement; sound because afterEach restores the captured real fetch.
    globalThis.fetch = ((input: string | URL | Request): Promise<Response> =>
        new Promise<Response>((resolve, reject) => {
            calls.push({
                url: String(input),
                resolve: (body, status = 200) => resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })),
                reject,
            });
        })) as unknown as typeof globalThis.fetch;
    return calls;
}
