import { rmSync } from "node:fs";

import { ensureRuntime, resolveConnectionMode, resolvePostgresConfig } from "../../lib/config.ts";
import { env } from "../../lib/env.ts";
import { promptText } from "../../lib/cli.ts";
import { composeUp, composeDown, composePullIfMissing, composeAvailable, ensureComposeFile } from "./compose.ts";

// `inflexa up` / `inflexa down` — explicit lifecycle commands for the infra
// stack. `up` is the same as the self-healing gate but user-initiated; `down`
// stops everything and optionally deletes persistent data.

/** `inflexa up` — start the infra containers (idempotent). */
export async function up(): Promise<void> {
    const rtResult = await ensureRuntime();
    if (rtResult.isErr()) {
        console.error(`\n  ${rtResult.error.message}\n`);
        process.exitCode = 1;
        return;
    }
    const rt = rtResult.value;

    if (!(await composeAvailable(rt))) {
        console.error(`\n  ${rt.label} Compose is not available.\n  Install it (https://docs.docker.com/compose/install/) and re-run.\n`);
        process.exitCode = 1;
        return;
    }

    const conn = resolvePostgresConfig();
    // `up` operates on the existing compose file; when it is missing, generate one for the currently
    // configured connection mode (postgres-only for a direct connection, proxy+postgres otherwise).
    const mode = resolveConnectionMode();
    const writeErr = ensureComposeFile(conn, mode).match(
        () => null,
        (e) => e,
    );
    if (writeErr) {
        console.error(`\n  ${writeErr.message}\n`);
        process.exitCode = 1;
        return;
    }

    const pullResult = await composePullIfMissing(rt, mode);
    if (pullResult.isErr()) {
        console.error(`\n  ${pullResult.error.message}\n`);
        process.exitCode = 1;
        return;
    }

    // `up` provisions the same preconditions as the launch gate purely by routing through composeUp's
    // guarded seam: in cliproxy mode the guard writes the proxy config before the engine runs (no
    // manufactured directory at its path); direct mode provisions nothing proxy-related.
    console.log("  Starting inflexa containers…");
    const upResult = await composeUp(rt, mode);
    if (upResult.isErr()) {
        console.error(`\n  ${upResult.error.message}\n`);
        process.exitCode = 1;
        return;
    }

    console.log("  Containers are running.");
    console.log(`  Proxy: ${env.cliproxyBaseUrl}`);
    console.log(`  Postgres: localhost:${conn.port}\n`);
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
 * deleting persistent data (Postgres data dir + proxy auth credentials).
 * Non-interactive terminals always decline.
 */
async function confirmDeleteData(): Promise<boolean> {
    console.log("\n  This will permanently delete:");
    console.log(`    • Postgres data at ${env.postgresDataDir}`);
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
