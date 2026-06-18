// dev:install — put the built executable on PATH as `inflexa` so you can run it
// system-wide while iterating. On macOS/Linux it SYMLINKS into dist/, so every
// `bun run build` is instantly live with no re-install (build's `rm -rf dist`
// doesn't break the link — it re-resolves once the new binary lands at the same
// path). On Windows it copies, since symlinks need elevation, so re-run after
// each build. Set INF_INSTALL_DIR to install somewhere other than the OS default.
import { copyFileSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { installDir, installedBinPath } from "../src/lib/env.ts";

// The host's compiled binary in dist/, matching scripts/build.ts naming (`inf-<os>-<arch>`,
// with Bun's auto `.exe` on Windows). Inline here, with its only caller, since it's a
// build-layout path (relative to the repo) rather than a runtime env path.
function builtBinPath(): string {
    const os = process.platform === "win32" ? "windows" : process.platform;
    const ext = process.platform === "win32" ? ".exe" : "";
    return join(import.meta.dir, "..", "dist", `inf-${os}-${process.arch}${ext}`);
}

// lstat (not existsSync) so a broken/dangling symlink still counts as present.
function exists(path: string): boolean {
    try {
        lstatSync(path);
        return true;
    } catch {
        return false;
    }
}

function onPath(dir: string): boolean {
    const sep = process.platform === "win32" ? ";" : ":";
    return (process.env.PATH ?? "").split(sep).some((entry) => entry.replace(/[/\\]$/, "") === dir);
}

const built = builtBinPath();
if (!exists(built)) {
    console.error(`No built executable found at:\n  ${built}`);
    console.error("Build it first:  bun run build");
    process.exit(1);
}

const target = installedBinPath();
const dir = installDir();

try {
    mkdirSync(dir, { recursive: true });
    const replacing = exists(target);
    rmSync(target, { force: true }); // clear a prior file/symlink (no-op if absent)
    if (process.platform === "win32") {
        copyFileSync(built, target);
    } else {
        symlinkSync(built, target);
    }
    console.log(`${replacing ? "Updated" : "Installed"}: ${target}`);
    console.log(
        process.platform === "win32"
            ? `  copied from ${built} — re-run \`bun run dev:install\` after each build.`
            : `  symlink → ${built} — future \`bun run build\`s apply automatically.`,
    );
} catch (cause) {
    // fs errors carry a string errno `code` (e.g. EACCES); read it to tailor the hint.
    const code = (cause as { code?: string }).code;
    console.error(`Failed to install to ${target}: ${String(cause)}`);
    if (code === "EACCES" || code === "EPERM") {
        console.error(`\n${dir} is not writable. Install it yourself with elevated permissions:`);
        console.error(
            process.platform === "win32"
                ? `  copy "${built}" "${target}"   (from an Administrator shell)`
                : `  sudo ln -sfn "${built}" "${target}"`,
        );
        console.error("…or set INF_INSTALL_DIR to a writable dir on your PATH (e.g. ~/.local/bin).");
    }
    process.exit(1);
}

// Smoke + PATH hint: run the freshly installed binary by absolute path (so PATH
// state can't mask it) and surface its version.
const probe = Bun.spawnSync([target, "--version"]);
if (probe.success) console.log(`  inflexa ${probe.stdout.toString().trim()}`);

if (!onPath(dir)) {
    const shell = process.env.SHELL ?? "";
    const rc = shell.includes("zsh") ? "~/.zshrc" : shell.includes("bash") ? "~/.bashrc" : "your shell profile";
    console.warn(`\nNote: ${dir} is not on your PATH. Add it, then restart your shell:`);
    console.warn(`  echo 'export PATH="${dir}:$PATH"' >> ${rc}`);
}
