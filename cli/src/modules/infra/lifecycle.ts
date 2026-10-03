import { rmSync } from "node:fs";

import { ensureRuntime, resolveConnectionMode, resolvePostgresConfig } from "../../lib/config.ts";
import { env } from "../../lib/env.ts";
import { promptText } from "../../lib/cli.ts";
import { composeDown, composeAvailable, postgresDataLocation, removePostgresVolume } from "./compose.ts";
import { ensureProxyReady } from "./setup.ts";

// `inflexa up` / `inflexa down` — explicit lifecycle commands for the infra
// stack. `up` is the same as the self-healing gate but user-initiated; `down`
// stops everything and optionally deletes persistent data.

/**
 * `inflexa up` — make the machine ready for the server (idempotent): the containers, the provider sign-in when the
 * login is absent or dead, and the embedder. The sign-in prompts only on a TTY. Gives false after it prints why, and
 * the caller sets the exit code.
 */
export async function up(): Promise<boolean> {
    const rtResult = await ensureRuntime();
    if (rtResult.isErr()) {
        console.error(`\n  ${rtResult.error.message}\n`);
        return false;
    }
    const rt = rtResult.value;

    if (!(await composeAvailable(rt))) {
        console.error(`\n  ${rt.label} Compose is not available.\n  Install it (https://docs.docker.com/compose/install/) and re-run.\n`);
        return false;
    }

    // The gate of the server boot, with the login prompt: it regenerates the compose file for the mode, starts
    // the containers, and probes the provider login.
    console.log("  Starting inflexa containers…");
    const ready = await ensureProxyReady(resolveConnectionMode());
    if (ready.isErr()) {
        console.error(`\n  ${ready.error.message}\n`);
        return false;
    }

    console.log("  Containers are running.");
    console.log(`  Proxy: ${env.cliproxyBaseUrl}`);
    console.log(`  Postgres: localhost:${resolvePostgresConfig().port}\n`);
    return true;
}

/** `inflexa down` — stop the infra containers, optionally delete data. */
export async function down(options: { deleteData: boolean }): Promise<void> {
    const rtResult = await ensureRuntime();
    if (rtResult.isErr()) {
        console.error(`\n  ${rtResult.error.message}\n`);
        process.exitCode = 1;
        return;
    }
    const rt = rtResult.value;

    if (options.deleteData) {
        const confirmed = await confirmDeleteData();
        if (!confirmed) {
            console.log("  Aborted — no data deleted.\n");
            return;
        }
    }

    console.log("  Stopping inflexa containers…");
    const downResult = await composeDown(rt);
    if (downResult.isErr()) {
        console.error(`\n  ${downResult.error.message}\n`);
        process.exitCode = 1;
        return;
    }

    if (options.deleteData) {
        console.log("  Deleting Postgres data…");
        try {
            rmSync(env.postgresDataDir, { recursive: true, force: true });
        } catch {
            console.error(`  Warning: could not delete ${env.postgresDataDir}`);
        }

        // On every platform, with no branch here: a host that is not Windows holds no such volume, and
        // the function reports that as `absent`. After composeDown above, because the engine refuses to
        // remove a volume that a container still uses. The rmSync above also runs on every platform: on
        // Windows nothing mounts that directory, but one can exist from a failed `initdb` on a bind mount.
        const volumeResult = await removePostgresVolume(rt);
        volumeResult.match(
            (outcome) => {
                if (outcome === "removed") console.log("  Deleted the Postgres volume.");
            },
            (e) => console.error(`  Warning: ${e.message}`),
        );

        console.log("  Deleting proxy credentials…");
        try {
            rmSync(env.cliproxyAuthDir, { recursive: true, force: true });
        } catch {
            console.error(`  Warning: could not delete ${env.cliproxyAuthDir}`);
        }

        console.log("  Data deleted. Run `inflexa setup` to start fresh.\n");
    } else {
        console.log("  Containers stopped. Run `inflexa up` to start them again.\n");
    }
}

/**
 * Destructive-data guard: require the user to type "I understand" before
 * deleting persistent data (the Postgres data, wherever {@link postgresDataLocation} puts it, + proxy
 * auth credentials).
 * Non-interactive terminals always decline.
 */
async function confirmDeleteData(): Promise<boolean> {
    const data = postgresDataLocation();
    console.log("\n  This will permanently delete:");
    console.log(data.kind === "bind" ? `    • Postgres data at ${data.path}` : `    • Postgres data in the container volume ${data.name}`);
    console.log(`    • Proxy credentials at ${env.cliproxyAuthDir}`);
    console.log();

    const answer = await promptText('Type "I understand" to confirm deletion', {
        validate: (v) => {
            if (v.trim() === "") return 'Type "I understand" or press Esc to cancel.';
            if (v.trim() !== "I understand") return 'Please type exactly "I understand" to confirm.';
            return undefined;
        },
    }).catch(() => "");

    return answer.trim() === "I understand";
}
