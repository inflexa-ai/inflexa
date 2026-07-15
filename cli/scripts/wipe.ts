// Dev reset: delete inflexa's on-disk state so the next run starts clean.
// Run via `bun run wipe` (the package script just forwards args here):
//   bun run wipe                  → interactive multiselect, then a y/N confirm
//   bun run wipe db,logs          → those targets, with a confirm
//   bun run wipe all --force      → every target, no confirm (for automation)
//
// Paths come straight from src/lib/env.ts — the sole path authority — so a wipe
// honors XDG_DATA_HOME / XDG_CONFIG_HOME (or the platform default) instead of
// hardcoding ~/.local/share. Repo artifacts (node_modules, dist) resolve from
// the script's own location, so the target is the repo regardless of cwd.
import { lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isCancel, multiselect } from "@clack/prompts";
import { env, installedBinPath } from "../src/lib/env.ts";
import { confirm } from "../src/lib/cli.ts";
import { selectedRuntime } from "../src/lib/config.ts";
import { capture, firstReadyRuntime, runtimeIds, runtimes } from "../src/lib/container.ts";

// lstat (not existsSync) so a dangling symlink — e.g. the installed `inflexa` after
// dist is wiped in the same run — still counts as present for the preview/count.
function exists(path: string): boolean {
    try {
        lstatSync(path);
        return true;
    } catch {
        return false;
    }
}

// Stop the container stack before the `infra` target's files are deleted. Deleting env.composeFilePath
// out from under a running stack orphans its containers (nothing left to reap them) AND removes the file
// `inflexa down` needs to stop them — so a delete-first wipe strands live containers with no clean way to
// recover them. Best-effort: resolve a runtime WITHOUT pinning (a dev wipe must never write a runtime
// choice into config — the same no-pin composition `sandbox status` uses), and only run `compose down`
// when both a runtime is ready and the compose file exists; otherwise there is no stack to stop.
async function stopInfraStack(): Promise<void> {
    if (!exists(env.composeFilePath)) {
        console.log("  infra: no compose file — skipping stack stop.");
        return;
    }
    const rt =
        selectedRuntime() ??
        (await firstReadyRuntime(runtimeIds.map((id) => runtimes[id]))).match(
            (detected) => detected,
            () => null,
        );
    if (rt === null) {
        console.log("  infra: no container runtime available — skipping stack stop (any running containers are left in place).");
        return;
    }
    console.log("  infra: stopping the container stack before deleting its files…");
    // Best-effort: ignore the exit code. `compose down` on an already-stopped or absent stack is a no-op,
    // and any failure here must not block the file deletion the user explicitly asked for.
    await capture(rt, ["compose", "-f", env.composeFilePath, "down"]);
}

// Repo artifacts are just another target (`repo`), so `all` needs no special case.
// Includes the dev-installed `inflexa` (dev_install.ts) so wiping `repo` undoes it.
const REPO_ARTIFACTS = [join(import.meta.dir, "..", "node_modules"), join(import.meta.dir, "..", "dist"), installedBinPath()];

// Each setting maps a friendly label to the absolute paths it deletes. `db` includes the WAL/SHM
// sidecars SQLite leaves beside agent.db (the connection runs journal_mode=WAL); `proxy` is the
// config file plus the provider-credential dir, per the spec; `infra` is the generated compose file plus
// the Postgres data dir, so a wipe can reset the container substrate that `inflexa setup` regenerates.
const TARGETS = {
    db: { label: "database — saved sessions (SQLite + WAL/SHM)", paths: [env.dbPath, `${env.dbPath}-wal`, `${env.dbPath}-shm`] },
    logs: { label: "logs", paths: [env.logDir] },
    proxy: { label: "proxy config + provider auth", paths: [env.cliproxyConfigPath, env.cliproxyAuthDir] },
    infra: { label: "infra (compose file + Postgres data)", paths: [env.composeFilePath, env.postgresDataDir] },
    config: { label: "config (settings)", paths: [env.configPath] },
    auth: { label: "auth (Auth0 tokens)", paths: [env.authPath] },
    repo: { label: "repo artifacts (node_modules, dist, installed inflexa)", paths: REPO_ARTIFACTS },
} as const;

type Target = keyof typeof TARGETS;

const KEYS = Object.keys(TARGETS) as Target[];

function isTarget(token: string): token is Target {
    return Object.prototype.hasOwnProperty.call(TARGETS, token);
}

// De-dup in case two targets ever share a path (none do today — cheap insurance).
function pathsFor(keys: readonly Target[]): string[] {
    return [...new Set(keys.flatMap((k) => TARGETS[k].paths))];
}

function usage(): never {
    console.error(`usage: bun scripts/wipe.ts [all|${KEYS.join("|")}][,…] [--force]`);
    console.error("  no targets → interactive multiselect; --force skips the confirm (targets required)");
    process.exit(1);
}

const rawArgs = process.argv.slice(2);
const force = rawArgs.includes("--force") || rawArgs.includes("-f");
// Targets may be space- or comma-separated (`wipe db logs` == `wipe db,logs`).
const tokens = rawArgs
    .filter((a) => a !== "--force" && a !== "-f")
    .flatMap((a) => a.split(","))
    .map((s) => s.trim())
    .filter(Boolean);

let selected: Target[];
if (tokens.length > 0) {
    // Explicit targets: `all` expands to every target; anything unknown is a usage error.
    if (tokens.includes("all")) {
        selected = KEYS;
    } else {
        const unknown = tokens.filter((t) => !isTarget(t));
        if (unknown.length > 0) {
            console.error(`unknown target(s): ${unknown.join(", ")}`);
            usage();
        }
        selected = tokens.filter(isTarget);
    }
} else {
    // No explicit targets: --force has nothing to act on, and the picker needs a TTY.
    if (force) {
        console.error("--force requires explicit targets (e.g. `wipe db,logs --force`).");
        usage();
    }
    if (!process.stdin.isTTY) {
        console.error("no targets given and stdin is not interactive — pass targets, e.g. `wipe db,logs --force`.");
        usage();
    }
    const picked = await multiselect<Target>({
        message: "Select what to wipe (space toggles, enter confirms):",
        options: KEYS.map((k) => ({ value: k, label: TARGETS[k].label, hint: TARGETS[k].paths.join(", ") })),
        required: false,
    });
    if (isCancel(picked) || picked.length === 0) {
        console.log("Aborted — nothing selected.");
        process.exit(0);
    }
    selected = picked;
}

const paths = pathsFor(selected);

// Preview the exact paths the chosen setting will delete, flagging what is on disk.
console.log(`will delete (${selected.join(", ")}):`);
for (const path of paths) console.log(`  ${exists(path) ? "present" : "absent "}  ${path}`);

// The safety gate — skipped only by --force (the explicit automation opt-out).
if (!force && !(await confirm("Delete these paths?"))) {
    console.log("Aborted — nothing deleted.");
    process.exit(0);
}

// Stop the infra stack before its files are deleted (see stopInfraStack) — only when the user is
// actually wiping infra, and only after the confirm, so an aborted wipe never touches containers.
if (selected.includes("infra")) await stopInfraStack();

let removed = 0;
for (const path of paths) {
    if (exists(path)) removed++;
    // force: never fail on an already-absent path; recursive: dirs and trees.
    rmSync(path, { recursive: true, force: true });
}
console.log(`Removed ${removed} of ${paths.length} path(s).`);
