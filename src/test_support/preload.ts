import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Install the global runtime extensions (JSON.parseWith, Promise.sleep, …) the way the app does at
// startup (src/index.ts), so any module under test that calls them (e.g. anchor/marker.ts →
// JSON.parseWith) works without each test file re-importing the loader.
import "../extensions/index.ts";

// Registered as a bun:test preload (bunfig.toml [test].preload), so this runs BEFORE any test
// module — and therefore before the first import of ../lib/env.ts, which Object.freezes its
// XDG-derived paths at import time. Redirecting XDG_DATA_HOME/XDG_CONFIG_HOME here is the only way
// to give integration tests an isolated SQLite DB + config dir instead of the developer's real
// home. POSIX-only: env.ts keys off XDG on macOS/Linux (the dev/CI platforms); on win32 it would
// read LOCALAPPDATA/APPDATA, which this sandbox does not set.
const sandbox = mkdtempSync(join(tmpdir(), "inf-test-"));
process.env.XDG_DATA_HOME = join(sandbox, "data");
process.env.XDG_CONFIG_HOME = join(sandbox, "config");

// bun test runs the whole suite in a single process, so one exit hook reaps the sandbox (the temp
// DB plus its -wal/-shm sidecars) after the last test file.
process.on("exit", () => {
    try {
        rmSync(sandbox, { recursive: true, force: true });
    } catch {
        // best effort — the OS reaps tmpdir anyway
    }
});
