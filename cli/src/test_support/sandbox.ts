import { sep } from "node:path";

/**
 * Authorizes ONE destructive filesystem op in the test suite. Throws unless the test preload
 * (src/test_support/preload.ts) stamped INFLEXA_TEST_SANDBOX **and** `pathBeingDestroyed` lives inside
 * that stamped sandbox. Call it FIRST, before any write/delete of an `env.*`-derived path.
 *
 * This is a per-site check, NOT the choke point every destructive site funnels through — nothing forces
 * a new writer to call it, and Incident 2 was exactly a writer that did not. The structural backstop is
 * the import-time guard in `src/lib/env.ts` (`isUnsandboxedTestRun`): under `NODE_ENV=test` with no
 * marker, the `env.*` paths never resolve at all, so an unguarded writer has no real path to destroy.
 * What this adds on top is the case that guard cannot see — a test that unsets the marker *after* env.ts
 * was imported (see harness.test.ts, which does precisely that to prove `resetDb` refuses).
 *
 * WHY either exists — data-loss hardening, after TWO live incidents. `bun test` run from the monorepo
 * ROOT does not apply cli/bunfig.toml's `[test].preload` (bun resolves bunfig from the cwd only and does
 * not walk up), so the preload never redirects XDG_* nor stamps the marker. Every `env.*` path then
 * resolves to the developer's REAL ~/.local/share/inflexa and ~/.config/inflexa. Incident 1 deleted
 * agent.db + config.json + the models dir. Incident 2 proved a guard on `resetDb` alone was too narrow:
 * `resetDb` correctly refused, but other unguarded writers still deleted config.json, emptied the models
 * dir, and clobbered agent.db.
 *
 * The containment test compares on a path BOUNDARY, not a bare `startsWith`: the marker is a
 * `mkdtempSync` root such as `/tmp/inflexa-test-AbC123`, and a sibling `/tmp/inflexa-test-AbC123-real`
 * shares that prefix while living entirely outside the sandbox. Exact equality is accepted too — the
 * sandbox root itself is a legitimate target (the preload's own exit hook reaps it).
 *
 * `throw` (not `Result`) is the right channel: this is test-support code, so aborting the run loudly IS
 * the correct outcome — a returned `Err` could be ignored by a careless caller and go on to destroy real
 * data, which is exactly what this guard prevents (per CLAUDE.md's throw policy, a test-harness boundary
 * that must abort the suite rather than continue). The message keeps the "test sandbox not active"
 * phrase the harness test asserts on.
 */
export function assertTestSandbox(pathBeingDestroyed: string): void {
    const sandbox = process.env.INFLEXA_TEST_SANDBOX;
    if (!sandbox || !isInsideSandbox(pathBeingDestroyed, sandbox)) {
        throw new Error(
            `refusing to write/delete ${pathBeingDestroyed}: test sandbox not active — run bun test from cli/ so bunfig's preload redirects XDG_* and stamps INFLEXA_TEST_SANDBOX`,
        );
    }
}

/**
 * Whether `candidate` is the sandbox root or a descendant of it. Purely lexical — neither path is
 * realpath'd, because the preload stamps the same `mkdtempSync` string that `env.*` is built from, so
 * both sides already share whatever symlink form the OS handed back (on macOS, `/var` → `/private/var`).
 */
function isInsideSandbox(candidate: string, sandbox: string): boolean {
    const root = sandbox.endsWith(sep) ? sandbox.slice(0, -sep.length) : sandbox;
    return candidate === root || candidate.startsWith(root + sep);
}
