import { closeSync, constants, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Make the marker of `dir` a named pipe. An open of it for a read waits until a writer opens it, the same as a
 * read on a hung network share, and its `stat` still answers. Give the result to {@link releaseHungMarker}.
 */
export function hungMarker(dir: string): string {
    mkdirSync(join(dir, ".inflexa"), { recursive: true });
    const path = join(dir, ".inflexa", "id");
    const made = Bun.spawnSync(["mkfifo", path]);
    if (made.exitCode !== 0) throw new Error(`mkfifo ${path} failed: ${made.stderr.toString()}`);
    return path;
}

/**
 * End each read that waits on the pipe, then put a plain file in its place, so a read that starts later does not
 * wait. The calls are synchronous, thus no read of the code under test can start between the two steps.
 */
export function releaseHungMarker(path: string): void {
    try {
        closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK));
    } catch {
        // ENXIO: no read waits on the pipe, thus there is nothing to end.
    }
    rmSync(path, { force: true });
    writeFileSync(path, "");
}
