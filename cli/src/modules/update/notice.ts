import pkg from "../../../package.json";
import { installChannel, upgradeInstruction, type InstallChannel } from "./channel.ts";

/** What a surface with a person in front of it must do about a newer release. See {@link updateOffer}. */
export type UpdateOffer =
    /** Say nothing: there is no newer release. */
    | { readonly kind: "none" }
    /** Ask whether to install `version`, and install it on a yes. */
    | { readonly kind: "ask"; readonly version: string }
    /** Report `version`, and name the command of the tool that owns this install. */
    | { readonly kind: "tell"; readonly version: string; readonly instruction: string };

/**
 * Which of the two shapes an interactive surface owes the user, for `version` on `channel`.
 *
 * The decision, apart from the drawing of it: a dialog whose only outcome is a line of text to copy is a
 * question with no answer in it, so a channel that inflexa cannot write to gets a report instead. The TUI
 * consumes this (tui/app.launch.tsx) and turns each case into its own widget.
 */
export function updateOffer(version: string | null, channel: InstallChannel): UpdateOffer {
    if (version === null) return { kind: "none" };
    const instruction = upgradeInstruction(channel);
    return instruction === null ? { kind: "ask", version } : { kind: "tell", version, instruction };
}

// Set by a surface that takes the terminal for itself. The TUI launchers return as soon as the renderer
// has the screen, so the command below them finishes while the alternate screen is live — a stderr write
// at that moment paints over the chat. The TUI asks its own question instead (tui/app.launch.tsx), so the
// claim is both the guard against that and the statement of which surface owns the message.
let claimed = false;

/** Claim the new-release message for a surface that owns the terminal. Call it BEFORE the screen is taken. */
export function claimUpdateNotice(): void {
    claimed = true;
}

/** TEST ONLY. Release the claim, so one test process can exercise both sides of it. Production never calls it. */
export function __releaseUpdateNoticeClaimForTest(): void {
    claimed = false;
}

/**
 * Report `version` as a newer release, on stderr.
 *
 * It is a REPORT, never a question. A subcommand's caller can be a script, an agent, or a build, and none
 * of them can answer one — the terminal question belongs to the TUI, which has a person in front of it.
 * stderr rather than stdout, so `inflexa … | jq` keeps its parseable stream.
 *
 * Silent unless stderr is a terminal. A redirected stream is a file or a pipe that some other program
 * reads, and this text means nothing to it.
 */
export function printUpdateNotice(version: string | null): void {
    if (version === null || claimed || !process.stderr.isTTY) return;

    // An installer install updates itself, so it gets the command that does that. Every other channel gets
    // the command of the tool that owns the file.
    const instruction = upgradeInstruction(installChannel()) ?? "inflexa upgrade";
    process.stderr.write(`\ninflexa ${version} is out (you have ${pkg.version}). Update with: ${instruction}\n`);
}
