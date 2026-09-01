import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { Result } from "neverthrow";
import { z } from "zod";

import pkg from "../../../package.json";
import { env } from "../../lib/env.ts";
import { installChannel, upgradeInstruction, type InstallChannel } from "./channel.ts";
import { isNewerVersion } from "./latest.ts";

/** How long one shown ask holds the next one. One day, the interval `gh` and `update-notifier` settled on. */
const ASK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The on-disk record of the last shown ask. `version` is the release that the ask named. */
const askStateSchema = z.object({ promptedAt: z.number(), version: z.string() });

type AskState = z.infer<typeof askStateSchema>;

/**
 * The recorded ask, or `null`. Absence is the NORMAL condition — no run showed an ask yet — so every
 * fault resolves to `null`: no file, bad bytes, a foreign schema. The cost of an unreadable record is
 * one extra ask, never a failure.
 */
function readAskState(): AskState | null {
    return Result.fromThrowable(
        () => askStateSchema.safeParse(JSON.parse(readFileSync(env.updateStatePath, "utf8"))),
        () => undefined,
    )().match(
        (parsed) => (parsed.success ? parsed.data : null),
        () => null,
    );
}

/** Record `version` as what the ask at `now` named. A write fault is swallowed for the reason {@link readAskState} gives. */
function writeAskState(version: string, now: number): void {
    Result.fromThrowable(
        () => {
            mkdirSync(dirname(env.updateStatePath), { recursive: true });
            writeFileSync(env.updateStatePath, JSON.stringify({ promptedAt: now, version } satisfies AskState, null, 4) + "\n");
        },
        () => undefined,
    )().match(
        () => undefined,
        () => undefined,
    );
}

/**
 * Whether the TUI may open the update dialog for `version` now. A `true` also records the ask, thus
 * the decision and the record are one step, and no caller can forget the write.
 *
 * Only the dialog is under this record, because a dialog interrupts. The stderr line and the TUI toast
 * are passive, so they show at each run. A `version` newer than the recorded one passes inside the
 * day: the read runs at each startup (latest.ts), and a same-day release must not wait behind a record
 * about an older release.
 *
 * Call it only at the moment the dialog really opens. A claim that a later guard drops would burn the
 * day with nothing shown.
 */
export function claimDailyAsk(version: string, now: number = Date.now()): boolean {
    const recorded = readAskState();
    const allowed = recorded === null || isNewerVersion(version, recorded.version) || now - recorded.promptedAt >= ASK_INTERVAL_MS;
    if (allowed) writeAskState(version, now);
    return allowed;
}

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
 *
 * Shown at each run: one line on stderr does not interrupt, so it carries no daily record. The dialog
 * of the TUI is the one surface under that record ({@link claimDailyAsk}).
 */
export function printUpdateNotice(version: string | null): void {
    if (version === null || claimed || !process.stderr.isTTY) return;

    // An installer install updates itself, so it gets the command that does that. Every other channel gets
    // the command of the tool that owns the file.
    const instruction = upgradeInstruction(installChannel()) ?? "inflexa upgrade";
    process.stderr.write(`\ninflexa ${version} is out (you have ${pkg.version}). Update with: ${instruction}\n`);
}
