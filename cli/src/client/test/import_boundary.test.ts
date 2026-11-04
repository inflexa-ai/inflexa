import { describe, expect, test } from "bun:test";

import { lintScratch, linesOf, OXLINT_SPAWN_TIMEOUT_MS, RESTRICTED_IMPORTS, RESTRICTED_SYNTAX, type Report, type Snippet } from "../../test_support/oxlint.ts";

// The cut between a client and the local server is a set of `eslint-js/no-restricted-syntax` entries in
// oxlint.config.ts. These runs lint snippets against the REAL config with the real `oxlint` binary: the bans are
// source selectors, and the folder of a file decides which override applies to it.

const SERVER_SIDE = [
    "../db/primary_query.ts",
    "../server/app.ts",
    "../lib/bus.ts",
    "@inflexa-ai/harness",
    "@inflexa-ai/harness/app/chat-turn.js",
    "../modules/harness/runtime.ts",
    "../../modules/analysis/analysis.ts",
];

const CLIENT_SAFE = [
    "../api/server.ts",
    "../client/api.ts",
    "../lib/env.ts",
    "@inflexa-ai/harness/contracts/index.js",
    "@inflexa-ai/harness/app/data-profile-view",
    "../modules/harness/plan_dag.ts",
    "../../modules/harness/chat_printer.ts",
    "../../modules/prov/verify_file.ts",
];

/** One import statement for each specifier. Specifier `i` sits on line `2 * i + 1`. */
function importsOf(specifiers: readonly string[]): string {
    return specifiers.map((s, i) => `import * as m${i} from "${s}";\nvoid m${i};`).join("\n");
}

/** The other forms that name a module, one on each line. */
const FORMS = [
    { path: "../server/app.ts", text: 'export * from "../server/app.ts";' },
    { path: "../db/primary_query.ts", text: 'export { x } from "../db/primary_query.ts";' },
    { path: "../lib/bus.ts", text: 'export const lazyBus = () => import("../lib/bus.ts");' },
    { path: "../modules/harness/runtime.ts", text: "export const lazyRuntime = () => import(`../modules/harness/runtime.ts`);" },
];

const CLIENT_SAFE_FORMS = [
    { path: "../../modules/prov/verify_file.ts", text: 'export const lazyVerify = () => import("../../modules/prov/verify_file.ts");' },
    { path: "../../modules/harness/chat_printer.ts", text: "export const lazyPrinter = () => import(`../../modules/harness/chat_printer.ts`);" },
];

/** Dynamic imports whose source is computed, one on each line. No other ban of the config matches the text of any of them. */
const COMPUTED_FORMS = [
    { label: "an interpolation at the start", text: "export const lazyStart = (name: string) => import(`./${name}.ts`);" },
    { label: "an interpolation after a permitted prefix", text: "export const lazyPrefix = (name: string) => import(`../api/${name}.ts`);" },
    { label: "a variable", text: "export const lazyVariable = (path: string) => import(path);" },
    { label: "a concatenation", text: 'export const lazyConcat = (name: string) => import("./" + name);' },
    { label: "a literal that is not a string", text: "export const lazyNumber = () => import(42);" },
];

const CASES = {
    tuiServerSide: { scope: "src/tui", ext: "tsx", text: importsOf(SERVER_SIDE) },
    clientServerSide: { scope: "src/client", ext: "ts", text: importsOf(SERVER_SIDE) },
    tuiClientSafe: { scope: "src/tui", ext: "tsx", text: importsOf(CLIENT_SAFE) },
    clientClientSafe: { scope: "src/client", ext: "ts", text: importsOf(CLIENT_SAFE) },
    typeOnly: { scope: "src/tui", ext: "ts", text: 'import type { AgentName } from "../modules/harness/agent_switch.ts";\n' },
    devChannel: { scope: "src/tui", ext: "ts", text: importsOf(["./dev/chat.ts"]) },
    productDevDynamic: { scope: "src/cli", ext: "ts", text: 'export const lazyDev = () => import("../../modules/harness/dev/run.ts");' },
    clientForms: { scope: "src/client", ext: "ts", text: FORMS.map((f) => f.text).join("\n") },
    clientSafeForms: { scope: "src/client", ext: "ts", text: CLIENT_SAFE_FORMS.map((f) => f.text).join("\n") },
    tuiComputed: { scope: "src/tui", ext: "ts", text: COMPUTED_FORMS.map((f) => f.text).join("\n") },
    clientComputed: { scope: "src/client", ext: "ts", text: COMPUTED_FORMS.map((f) => f.text).join("\n") },
    serverComputed: { scope: "src/server", ext: "ts", text: COMPUTED_FORMS.map((f) => f.text).join("\n") },
    serverFolder: { scope: "src/server", ext: "ts", text: importsOf(SERVER_SIDE) },
} satisfies Record<string, Snippet>;

type CaseName = keyof typeof CASES;

let lintOnce: Promise<Map<string, Report[]>> | undefined;

/** The reports of the case `name`. One oxlint spawn serves the whole suite. */
async function reportsOf(name: CaseName): Promise<Report[]> {
    lintOnce ??= (async () => {
        const entries = Object.entries(CASES);
        const run = await lintScratch(entries.map(([, snippet]) => snippet));
        return new Map(entries.map(([entryName], i) => [entryName, run.snippets[i] ?? []]));
    })();
    return (await lintOnce).get(name) ?? [];
}

/** The specifiers of `specifiers` that `rule` reports in the case `name`. */
async function banned(name: CaseName, specifiers: readonly string[], rule: string): Promise<string[]> {
    const lines = new Set(linesOf(await reportsOf(name), rule));
    return specifiers.filter((_, i) => lines.has(i * 2 + 1));
}

/** The paths of `forms` that `rule` reports in the case `name`. Form `i` sits on line `i + 1`. */
async function bannedForms(name: CaseName, forms: readonly { path: string }[], rule: string): Promise<string[]> {
    const lines = new Set(linesOf(await reportsOf(name), rule));
    return forms.filter((_, i) => lines.has(i + 1)).map((f) => f.path);
}

/** The labels of `COMPUTED_FORMS` that `rule` reports in the case `name`. Form `i` sits on line `i + 1`. */
async function bannedComputed(name: CaseName, rule: string): Promise<string[]> {
    const lines = new Set(linesOf(await reportsOf(name), rule));
    return COMPUTED_FORMS.filter((_, i) => lines.has(i + 1)).map((f) => f.label);
}

describe("the client import boundary", () => {
    test(
        "a TUI file cannot import the server side",
        async () => {
            expect(await banned("tuiServerSide", SERVER_SIDE, RESTRICTED_SYNTAX)).toEqual(SERVER_SIDE);
        },
        OXLINT_SPAWN_TIMEOUT_MS,
    );

    test(
        "a client file cannot import the server side",
        async () => {
            expect(await banned("clientServerSide", SERVER_SIDE, RESTRICTED_SYNTAX)).toEqual(SERVER_SIDE);
        },
        OXLINT_SPAWN_TIMEOUT_MS,
    );

    test(
        "a TUI file can import the wire types and the pure helpers",
        async () => {
            expect(await banned("tuiClientSafe", CLIENT_SAFE, RESTRICTED_SYNTAX)).toEqual([]);
        },
        OXLINT_SPAWN_TIMEOUT_MS,
    );

    test(
        "a client file can import the wire types and the pure helpers",
        async () => {
            expect(await banned("clientClientSafe", CLIENT_SAFE, RESTRICTED_SYNTAX)).toEqual([]);
        },
        OXLINT_SPAWN_TIMEOUT_MS,
    );

    test(
        "a client file cannot re-export the server side or import it lazily, with a string or a template literal",
        async () => {
            expect(await bannedForms("clientForms", FORMS, RESTRICTED_SYNTAX)).toEqual(FORMS.map((f) => f.path));
        },
        OXLINT_SPAWN_TIMEOUT_MS,
    );

    test(
        "a client file can import a pure helper lazily, with a string or a template literal",
        async () => {
            expect(await bannedForms("clientSafeForms", CLIENT_SAFE_FORMS, RESTRICTED_SYNTAX)).toEqual([]);
        },
        OXLINT_SPAWN_TIMEOUT_MS,
    );

    for (const scope of ["tui", "client"] as const) {
        test(
            `a ${scope} file cannot import lazily with a computed source`,
            async () => {
                expect(await bannedComputed(`${scope}Computed`, RESTRICTED_SYNTAX)).toEqual(COMPUTED_FORMS.map((f) => f.label));
                const messages = (await reportsOf(`${scope}Computed`)).filter((r) => r.rule === RESTRICTED_SYNTAX).map((r) => r.message);
                expect(messages.filter((message) => !message.includes("A client must write the path of a dynamic `import()` out"))).toEqual([]);
            },
            OXLINT_SPAWN_TIMEOUT_MS,
        );
    }

    test(
        "a type-only import of a module is banned too: a client takes each wire type from src/api/",
        async () => {
            expect(linesOf(await reportsOf("typeOnly"), RESTRICTED_SYNTAX)).toContain(1);
        },
        OXLINT_SPAWN_TIMEOUT_MS,
    );

    test(
        "a client file cannot import a dev-channel surface: the `src/**` import ban applies",
        async () => {
            expect(await banned("devChannel", ["./dev/chat.ts"], RESTRICTED_IMPORTS)).toEqual(["./dev/chat.ts"]);
        },
        OXLINT_SPAWN_TIMEOUT_MS,
    );

    test(
        "a product file cannot import a dev-channel surface lazily without a directive",
        async () => {
            expect(linesOf(await reportsOf("productDevDynamic"), RESTRICTED_IMPORTS)).toEqual([1]);
        },
        OXLINT_SPAWN_TIMEOUT_MS,
    );

    test(
        "the server side itself is outside the rule",
        async () => {
            expect(await banned("serverFolder", SERVER_SIDE, RESTRICTED_SYNTAX)).toEqual([]);
            expect(await bannedComputed("serverComputed", RESTRICTED_SYNTAX)).toEqual([]);
        },
        OXLINT_SPAWN_TIMEOUT_MS,
    );
});
