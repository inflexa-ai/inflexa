import { basename, sep } from "node:path";

/** Filename prefix every legitimate marker carries: the preload mints `mkdtempSync(join(tmpdir(), "inflexa-test-"))`. */
const SANDBOX_MARKER_PREFIX = "inflexa-test-";

/**
 * Authorizes ONE destructive filesystem op in the test suite. Throws unless the test preload
 * (src/test_support/preload.ts) stamped a well-formed `inflexa-test-*` INFLEXA_TEST_SANDBOX marker
 * **and** `pathBeingDestroyed` lives inside that stamped sandbox. Call it FIRST, before any write/delete
 * of an `env.*`-derived path.
 *
 * Three refusal reasons funnel through the single `throw`, so every consumer inherits all three: the
 * marker is unset, the marker is MALFORMED ({@link isSandboxMarkerShaped}), or the path is not contained
 * ({@link isInsideSandbox}). The shape gate closes a hole the value-only check left open: `isInsideSandbox`
 * is pure prefix containment, so a hand-exported `INFLEXA_TEST_SANDBOX=$HOME` collapses the sandbox root
 * to the developer's home and `=/` collapses it to `""` — under either, every real `env.*` path counts as
 * "inside" and the guard would authorize destroying real data (the original data-loss incident, recreated
 * with one env var by a developer annoyed at the refusal). Validating the marker's SHAPE — not merely
 * trusting its value — refuses both before any deletion.
 *
 * This is a per-site check, NOT the choke point every destructive site funnels through — nothing forces
 * a new writer to call it, and Incident 2 was exactly a writer that did not. The structural backstop is
 * the import-time guard in `src/lib/env.ts` (`isUnsandboxedTestRun`): under `NODE_ENV=test` with no
 * marker, the `env.*` paths never resolve at all, so an unguarded writer has no real path to destroy.
 * That backstop PRESUMES NODE_ENV=test — which `bun test` sets by default, but a shell that pre-exported
 * it (`NODE_ENV=development bun test`; bun does not force it) silently disables, so the env.ts guard
 * never fires and this per-site check becomes the ONLY guard. So a test whose flow writes an `env.*` path
 * (e.g. the runtime boot tests, which acquire the runtime lock under `env.locksDir`) must call it,
 * ideally in a `beforeEach`.
 * What this adds on top is also the case that guard cannot see — a test that unsets or REWRITES the
 * marker *after* env.ts was imported (see harness.test.ts, which does precisely that to prove `resetDb`
 * refuses).
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
 * that must abort the suite rather than continue). The message keeps the "test sandbox not active" phrase
 * the harness test asserts on, names WHY the marker was rejected, and states how a real sandbox is
 * legitimately established (run `bun test` from cli/).
 */
export function assertTestSandbox(pathBeingDestroyed: string): void {
    const reason = refusalReason(pathBeingDestroyed, process.env.INFLEXA_TEST_SANDBOX);
    if (reason !== null) {
        throw new Error(
            `refusing to write/delete ${pathBeingDestroyed}: test sandbox not active — ${reason}. Run \`bun test\` from cli/ so bunfig's [test].preload redirects XDG_* and stamps INFLEXA_TEST_SANDBOX with a fresh ${SANDBOX_MARKER_PREFIX}* sandbox root.`,
        );
    }
}

/**
 * The reason `path` may NOT be destroyed under `marker`, or `null` when the op is authorized. Split from
 * the `throw` so each branch returns a plain const string (no reassignment) and the decision is
 * unit-testable in isolation. Order is deliberate — absent → malformed shape → not contained — so a
 * rejected marker never reaches the containment check that its bad value would otherwise fool.
 */
function refusalReason(path: string, marker: string | undefined): string | null {
    if (!marker) return "the INFLEXA_TEST_SANDBOX marker is unset";
    if (!isSandboxMarkerShaped(marker)) {
        return `the marker "${marker}" is not a ${SANDBOX_MARKER_PREFIX}* mkdtemp root — an exported $HOME or / must never authorize destroying real data`;
    }
    if (!isInsideSandbox(path, marker)) return `"${path}" lies outside the sandbox "${marker}"`;
    return null;
}

/**
 * Whether `marker` has the SHAPE the preload always mints: a `mkdtempSync(join(tmpdir(), "inflexa-test-"))`
 * root, whose basename therefore begins with {@link SANDBOX_MARKER_PREFIX}. This validates the marker's
 * VALUE and is deliberately SEPARATE from {@link isInsideSandbox} (pure lexical containment over a root):
 * the shape is a property of the marker, containment a property of a candidate path — keeping them apart
 * leaves each a single responsibility and independently testable. The check is wired into the
 * `assertTestSandbox` choke point (via {@link refusalReason}), NOT inside `isInsideSandbox`, so the
 * containment predicate stays pure — and because `isInsideSandbox` is private with `assertTestSandbox` as
 * its ONLY caller, there is no second consumer that would need its own copy of the guard.
 *
 * A basename-prefix check, not a `homedir()`-prefix check: a real mkdtemp sandbox lives under `tmpdir()`,
 * never an ancestor of the developer's home, so the two attack values the value-only guard accepted —
 * `$HOME` (basename = the username) and `/` (basename = `""`) — both fail this prefix. A "marker is a
 * prefix of homedir()" rule would also reject `/`, but this gate already subsumes it (a well-formed
 * `inflexa-test-*` root can never be an ancestor of home), so adding it would only be an unreachable branch.
 */
function isSandboxMarkerShaped(marker: string): boolean {
    return basename(marker).startsWith(SANDBOX_MARKER_PREFIX);
}

/**
 * Whether `candidate` is the sandbox root or a descendant of it. Purely lexical — neither path is
 * realpath'd, because the preload stamps the same `mkdtempSync` string that `env.*` is built from, so
 * both sides already share whatever symlink form the OS handed back (on macOS, `/var` → `/private/var`).
 * The marker's SHAPE is validated upstream ({@link isSandboxMarkerShaped}); this trusts the root it is
 * handed and decides containment only.
 */
function isInsideSandbox(candidate: string, sandbox: string): boolean {
    const root = sandbox.endsWith(sep) ? sandbox.slice(0, -sep.length) : sandbox;
    return candidate === root || candidate.startsWith(root + sep);
}
