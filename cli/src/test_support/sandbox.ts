/**
 * The SINGLE authorization for every destructive filesystem op in the test suite. Throws unless the
 * test preload (src/test_support/preload.ts) stamped INFLEXA_TEST_SANDBOX **and** `pathBeingDestroyed`
 * lives inside that stamped sandbox. Call it FIRST, before any write/delete of an `env.*`-derived path.
 *
 * WHY this exists — data-loss hardening, after TWO live incidents. `bun test` run from the monorepo
 * ROOT does not apply cli/bunfig.toml's `[test].preload` (bun resolves bunfig from the cwd only and
 * does not merge a subdirectory's config), so the preload never redirects XDG_* nor stamps the marker.
 * Every `env.*` path then resolves to the developer's REAL ~/.local/share/inflexa and
 * ~/.config/inflexa, and any test that writes or deletes such a path destroys live data. Incident 1
 * deleted agent.db + config.json + the models dir. Incident 2 proved a guard on `resetDb` alone was
 * too narrow: `resetDb` correctly refused, but OTHER unguarded writers still deleted config.json,
 * emptied the models dir, and clobbered agent.db (a raw `writeFileSync(env.dbPath, …)` +
 * `rmSync(env.dbPath)` in a test that runs with the marker deliberately removed). So the fix is ONE
 * choke point every destructive env-path site funnels through — do not re-inline the marker check
 * anywhere; import and call this instead.
 *
 * `startsWith(sandbox)` matches the original resetDb guard exactly: the marker is the sandbox ROOT
 * (a `mkdtempSync` dir), and env.dbPath / env.configPath / env.embeddingModelPath all resolve under it
 * (XDG_DATA_HOME = <sandbox>/data, XDG_CONFIG_HOME = <sandbox>/config).
 *
 * `throw` (not `Result`) is the right channel: this is test-support code, so aborting the run loudly
 * IS the correct outcome — a returned `Err` could be ignored by a careless caller and go on to destroy
 * real data, which is exactly what this guard prevents (per CLAUDE.md's throw policy, a test-harness
 * boundary that must abort the suite rather than continue). The message keeps the "test sandbox not
 * active" phrase the harness test asserts on.
 */
export function assertTestSandbox(pathBeingDestroyed: string): void {
    const sandbox = process.env.INFLEXA_TEST_SANDBOX;
    if (!sandbox || !pathBeingDestroyed.startsWith(sandbox)) {
        throw new Error(
            `refusing to write/delete ${pathBeingDestroyed}: test sandbox not active — run bun test from cli/ so bunfig's preload redirects XDG_* and stamps INFLEXA_TEST_SANDBOX`,
        );
    }
}
