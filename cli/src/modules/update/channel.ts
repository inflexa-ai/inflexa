import { realpathSync } from "node:fs";

import { Result } from "neverthrow";

import { isCompiledBinary } from "../../lib/install_context.ts";

/**
 * How this binary reached the machine. The answer decides what an upgrade is permitted to do: only
 * `installer` owns the file it runs from, so only `installer` may replace that file.
 *
 * Derived from the path, not from a marker the installer writes. A marker would be correct only for an
 * install made after the marker shipped, and every machine that already has inflexa would report
 * `unknown` forever. The path is a fact about EVERY install, old ones included. `deno`, `bun`, and `uv`
 * read the path for the same reason.
 */
export type InstallChannel =
    /** `install.sh` or `install.ps1` put the binary in place, so nothing else tracks the file. */
    | "installer"
    /** Under a Homebrew Cellar. The formula owns the file, and `brew upgrade` is the only correct writer. */
    | "homebrew"
    /** Inside a `node_modules` tree, delivered by the `@inflexa-ai/inflexa` wrapper. npm owns the file. */
    | "npm"
    /** `bun run dev`, a test process, or any run that is not the compiled binary. There is no file to replace. */
    | "source";

/** The path segments of `path`, on either separator, with the empty ones dropped. */
function segments(path: string): string[] {
    return path.split(/[\\/]/).filter((segment) => segment.length > 0);
}

/**
 * True when `parts` holds `first` and then `second` after it. Both npm and Homebrew are recognized by a
 * PAIR of segments rather than by one: a lone `node_modules` says nothing about which package owns the
 * file, and a lone `Cellar` is a directory name that any tree can carry.
 */
function hasOrderedSegments(parts: string[], first: string, second: (part: string) => boolean): boolean {
    const start = parts.indexOf(first);
    return start >= 0 && parts.slice(start + 1).some(second);
}

/**
 * The install channel of the running binary, or of `execPath` when a test gives one.
 *
 * The path is resolved through its symbolic links first, because Homebrew's own entry is a link: a user
 * runs `<prefix>/bin/inflexa`, and only the target under `<prefix>/Cellar/inflexa/<version>/bin/` names
 * the channel. A path that cannot resolve is read as it stands, which costs at most a `homebrew` install
 * read as `installer`.
 */
export function installChannel(execPath: string = process.execPath): InstallChannel {
    if (!isCompiledBinary()) return "source";

    const resolved = Result.fromThrowable(
        () => realpathSync(execPath),
        () => undefined,
    )().unwrapOr(execPath);
    const parts = segments(resolved);

    // The wrapper spawns the binary out of the platform package it resolved
    // (`node_modules/@inflexa-ai/inflexa-<platform>-<arch>/bin/`), and its postinstall fallback puts one
    // under `node_modules/@inflexa-ai/inflexa/bin-fallback/`. The pnpm layout nests a second
    // `node_modules` above the same scope directory, so the ORDER of the two segments is what both
    // layouts share.
    if (hasOrderedSegments(parts, "node_modules", (part) => part === "@inflexa-ai")) return "npm";

    // The formula installs to `<prefix>/Cellar/inflexa/<version>/bin/inflexa` on macOS and on Linux
    // alike, so the pair is the same on both.
    if (hasOrderedSegments(parts, "Cellar", (part) => part === "inflexa")) return "homebrew";

    return "installer";
}

/**
 * The command that updates an install of `channel`, or `null` when inflexa updates itself there.
 *
 * A channel whose package manager owns the file gets the command of that manager, never a replacement
 * written behind its back: the manager's records would then describe a file that is no longer on disk.
 */
export function upgradeInstruction(channel: InstallChannel): string | null {
    switch (channel) {
        case "installer":
            return null;
        case "homebrew":
            return "brew upgrade inflexa";
        case "npm":
            return "npm install -g @inflexa-ai/inflexa@latest";
        case "source":
            return "git pull";
        default: {
            const unreachable: never = channel;
            throw new Error(`unhandled install channel: ${String(unreachable)}`);
        }
    }
}
