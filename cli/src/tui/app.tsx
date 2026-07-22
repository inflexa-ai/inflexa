import { ResultAsync } from "neverthrow";
import { createEffect, createSignal, Show } from "solid-js";
import type { BoxRenderable, CliRenderer, Renderable, TextareaRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import type { AskReply } from "@inflexa-ai/harness";
import { causeDetailLines, describeCause } from "../lib/cause.ts";
import { GLYPHS, size, zIndex } from "../lib/design_system.ts";
import { contractHome } from "../lib/paths.ts";
import { shutdown } from "../lib/shutdown.ts";
import { writeClipboard } from "../lib/clipboard.ts";
import { theme, themeVariant, noticeColor, type Notice } from "./theme.ts";
import { chatStatus } from "./hooks/status.ts";
import { bootState, harnessRuntime, watchAgentModels } from "./hooks/boot.ts";
import * as conversation from "./hooks/conversation.ts";
import { activeAsk, queuedCount, settleAsk, type PendingAsk } from "./hooks/asks.ts";
import { currentNotice, notify } from "./hooks/notice.ts";
import { openArtifact } from "./hooks/artifacts.ts";
import { profileSnapshot, watchSidebarData, profileDetailLines } from "./hooks/sidebar_live.ts";
import { commands } from "./commands.tsx";
import { CommandPalette, runCommand } from "./components/command_palette.tsx";
import { ResultsDialog } from "./components/dialog/results_dialog.tsx";
import { dialogPush, dialogClose, dialogIsOpen, DialogOverlay } from "./components/dialog/dialog_host.tsx";
import { useKeymapRoot, useBindings, MODE_BASE, resolveKeybind, keybindLabel, interruptHintLabel, leaderSeq, KEYS, type LayerConfig } from "./keymap.ts";
import { StatusBar } from "./layout/status_bar.tsx";
import { Chat } from "./components/chat.tsx";
import { BootIndicator } from "./components/boot_indicator.tsx";
import { AskPrompt } from "./components/ask_prompt.tsx";
import { ChatBar } from "./layout/chat_bar.tsx";
import { Sidebar } from "./layout/sidebar.tsx";
import { WhichKey } from "./layout/which_key.tsx";
import { WorkspaceContext, createWorkspace } from "./contexts/workspace.ts";
import { watchProfileParity, driveForceReprofile } from "./hooks/profile_parity.ts";
import { listAnalysisInputs } from "../db/primary_query.ts";
import type { Analysis } from "../types/analysis.ts";

type AppProps = {
    sessionId: string;
    workingDir: string;
    analysis: Analysis;
};

/**
 * The real "esc clears a live text selection" key layer, built as a pure factory over the renderer so
 * the render test drives the SAME config `App` installs — not a hand-copied replica that could silently
 * drift out of sync. `App` registers it with `useBindings(() => selectionClearLayer(renderer))`, which
 * re-invokes it on every keystroke so `enabled` re-reads the live selection.
 *
 * It is mode-less and priority 50 on purpose: above the dialog host's structural esc (priority 0), so a
 * span selected inside a dialog deselects WITHOUT closing the dialog, and below the abort chord
 * (priority 100), which owns its own selection-aware copy path. Mode-less (not MODE_BASE) because a
 * selection can be live while a dialog is stacked and MODE_BASE layers suspend under a modal — this must
 * still fire there. `enabled` reads the SELECTED TEXT, not `hasSelection`: a plain click on selectable
 * text leaves a non-null but EMPTY Selection, so `hasSelection` would arm on every click and swallow
 * esc's real jobs (dialog cancel, INSERT→NORMAL). Clear only — copy-on-select already wrote the
 * clipboard on mouse-up, so esc must not re-copy. With no selected text the layer is disabled and esc
 * falls through unchanged to every existing binding.
 */
export function selectionClearLayer(renderer: CliRenderer): LayerConfig {
    return {
        priority: 50,
        enabled: !!renderer.getSelection()?.getSelectedText(),
        bindings: [{ chord: KEYS.escape, run: () => renderer.clearSelection(), desc: "Clear selection", group: "App" }],
    };
}

/** The seams the {@link retractLayer} factory closes over — the composer it gates on and the retract hook it drives. */
export type RetractLayerDeps = {
    /**
     * The chat composer this layer is focus-`target`-gated to. Doubles as the buffer whose emptiness gates
     * arming (`plainText === ""`) and as the seed target the retract writes the original text back into.
     */
    readonly target: TextareaRenderable | null;
    /** The conversation retract seam: whether a retract is possible right now, and the retract itself. */
    readonly conversation: Pick<typeof conversation, "canRetract" | "retract">;
};

/**
 * The real "up-arrow retracts the just-sent message back into the composer" key layer, built as a pure
 * factory over its deps so a dispatch test drives the SAME config `App` installs — not a hand-copied
 * replica that could drift. `App` registers it with `useBindings(() => retractLayer({ target: textareaRef,
 * conversation }))`, re-invoked each keystroke so `enabled` re-reads the live buffer and retract window.
 *
 * Live ONLY while the composer is empty AND the retract window holds (a busy turn that has produced
 * nothing; the hook owns that gate via `canRetract`). Gated to an EMPTY buffer so a non-empty composer
 * disables the binding and `up` falls through to the textarea's own cursor movement, and so the seed can
 * never overwrite text the user has typed. Its own layer (not folded into the clear-input/scroll-mode
 * layer) so the empty+retractable gate does not also disable those. `setText` leaves the caret at offset
 * 0, so `gotoBufferEnd` lands it after the seeded text ready to edit. Idle up-arrow stays inert here,
 * leaving the chord free for future recall.
 */
export function retractLayer(deps: RetractLayerDeps): LayerConfig {
    const target = deps.target;
    return {
        mode: MODE_BASE,
        target,
        enabled: target?.plainText === "" && deps.conversation.canRetract(),
        bindings: [
            {
                chord: KEYS.up,
                run: () =>
                    void deps.conversation.retract((t) => {
                        target?.setText(t);
                        target?.gotoBufferEnd();
                    }),
                desc: "Retract message",
                group: "Chat",
            },
        ],
    };
}

/** The seams the {@link interruptLayer} factory closes over — its focus target, its enable inputs, and the interrupt hook it drives. */
export type InterruptLayerDeps = {
    /** The stream pane this layer is focus-`target`-gated to (live only in NORMAL mode, pane focused). */
    readonly target: Renderable | null;
    /** True while a turn is in flight — the layer only arms/fires during a busy turn. */
    readonly busy: () => boolean;
    /** The live selected text (empty when none) — a live selection excludes the interrupt (see below). */
    readonly selectedText: () => string;
    /** The conversation interrupt seam: the armed-state read, arm-the-window, and fire-the-abort. */
    readonly conversation: Pick<typeof conversation, "interruptArmed" | "armInterrupt" | "abort">;
};

/**
 * The real double-press interrupt key layer, built as a pure factory over its deps so a dispatch test
 * drives the SAME config `App` installs — not a hand-copied replica that could drift. `App` registers it
 * with `useBindings(() => interruptLayer({ ... }))`, re-invoked each keystroke so `enabled` re-reads the
 * live busy/selection state and `run` re-reads the armed flag.
 *
 * Live only while a turn is busy and the stream pane holds focus (NORMAL mode): the first press arms a
 * short window, a second within it fires the turn's abort (the hook disarms on finishTurn AND on the
 * abort itself). A separate layer from the i/enter/o keys so its busy gate does not disable those. Dialog
 * gating is structural — MODE_BASE suspends under a modal AND a stacked dialog steals the pane's focus, so
 * the layer is doubly inert while a dialog is open. A live text selection is excluded two ways: the
 * higher-priority `selectionClearLayer` (priority 50 vs this layer's 0) owns the esc press first and
 * returns handled, so the interrupt never observes it, and the explicit `enabled` selection check keeps it
 * disarmed regardless of that ordering. Idle → disabled, so esc in NORMAL stays the deliberate no-op it is today.
 */
export function interruptLayer(deps: InterruptLayerDeps): LayerConfig {
    return {
        mode: MODE_BASE,
        target: deps.target,
        enabled: deps.busy() && !deps.selectedText(),
        bindings: [
            {
                chord: resolveKeybind("app.interrupt"),
                run: () => {
                    if (deps.conversation.interruptArmed()) deps.conversation.abort();
                    else deps.conversation.armInterrupt();
                },
                desc: "Interrupt turn (again to confirm)",
                group: "Chat",
            },
        ],
    };
}

/**
 * Derive the status-bar interrupt affordance from the live turn state, or `undefined` when it must not
 * show. Pure over its inputs so both `App`'s `interruptHint` thunk and its unit coverage exercise ONE
 * derivation. Present only while a turn is `busy` AND the chat is in NORMAL mode (`insertMode` false, the
 * stream pane holds focus): the interrupt binding is reachable only there, so showing the hint while the
 * composer is focused (INSERT) would advertise a key that merely switches modes. The label + armed styling
 * come from {@link interruptHintLabel} (the shared wording source).
 */
export function interruptHintFor(opts: { busy: boolean; insertMode: boolean; armed: boolean; key: string }): { label: string; armed: boolean } | undefined {
    if (!opts.busy || opts.insertMode) return undefined;
    return { label: interruptHintLabel(opts.key, opts.armed), armed: opts.armed };
}

export function App(props: AppProps) {
    const dims = useTerminalDimensions();
    const renderer = useRenderer();

    const [sidebarOpen, setSidebarOpen] = createSignal(true);
    // INSERT vs NORMAL is pure composer focus (see the focus-choreography note below). The ChatBar footer
    // already tracks this off the textarea's focus via its `onFocusChange`; mirror that SAME signal here so
    // the status-bar interrupt hint gates on NORMAL mode without a second, independent focus tracker. Seeds
    // `true` to match the composer's focus-on-mount (and ChatBar's own default) — the app opens in INSERT.
    const [composerFocused, setComposerFocused] = createSignal(true);

    // INSERT vs NORMAL is pure focus: the textarea holds focus in INSERT (the default); esc moves
    // focus to the stream's ScrollPane (NORMAL — its focus-gated scroll keys go live). Focus is
    // ALWAYS on one of these widgets, so the dialog host's save/restore never sees a null focus. A
    // docked ask prompt is a third, transient focus holder while an ask pends (the effect below moves
    // focus to it on ask-active and restores the textarea on drain).
    let textareaRef: TextareaRenderable | null = null;
    let scrollPaneRef: ScrollBoxRenderable | null = null;
    // The docked approval prompt's focusable box, handed back via its onFocusReady. Null while no ask
    // is pending (the prompt is unmounted).
    let promptRef: BoxRenderable | null = null;

    // Quit cleanly: destroy() restores the terminal (mouse tracking, alternate screen, cooked mode)
    // before exit — process.exit() alone skips OpenTUI's cleanup and leaves the shell broken.
    async function quit(): Promise<void> {
        renderer.destroy();
        await shutdown(0);
    }

    // The workspace context store. Its reactivity and the `openSession` write path live in
    // contexts/workspace.ts; App supplies the capabilities (which close over its local state). The
    // chat hot-state reset on an in-place swap is driven reactively by the `Chat` component (an
    // effect on `workspace.sessionId`), so App no longer passes an imperative reset hook. Seeded
    // once from props — App mounts a single time with fixed props — so the body-level reads are a
    // deliberate one-time seed, hence the scoped disable.
    /* eslint-disable solid/reactivity -- seed-once: App mounts once with fixed props; the store is seeded from them and thereafter written only via openSession */
    const workspace = createWorkspace({
        analysis: props.analysis,
        sessionId: props.sessionId,
        workingDir: props.workingDir,
        openDialog: dialogPush,
        closeDialog: dialogClose,
        quit,
    });
    /* eslint-enable solid/reactivity */

    // Auto-trigger the data profile at parity: fires once boot is `ready` and again on an
    // in-place analysis swap, fire-and-forget, mapping the outcome to a notice. An app-level reactive
    // hook so the boot/analysis watch runs under App's reactive owner; never fires before `ready`.
    watchProfileParity(workspace);

    // Wire the sidebar's live-data lifecycle: lifecycle-edge refreshes + the bounded,
    // active-work-gated poll. One call, under App's reactive owner (the store holds the snapshots the
    // Sidebar renders and the details views below snapshot on open).
    watchSidebarData(workspace);

    // Mirror the live agent switch into the boot store's agentModels cell: the
    // status surface (sidebar MODELS section) renders each agent's active model + any pending switch. Seeds
    // at the ready edge and follows every later swap/schedule. Under App's reactive owner.
    watchAgentModels();

    // Open the DATA PROFILE details view. Snapshots the profile as of open (a
    // point-in-time view) and hands the composed lines to `ResultsDialog`, reused verbatim. The
    // optional `r re-profile` footer action drives a DELIBERATE force re-profile: offered only when
    // one could actually start — boot ready (so a runtime exists), no profile currently running, and
    // at least one input to profile. All three are snapshotted at open (the dialog does not track them
    // changing after it opens); after firing it closes, so the sidebar + toast carry the live outcome.
    function openProfile(): void {
        const snap = profileSnapshot();
        const analysis = workspace.analysis;
        const name = analysis?.name;
        const title = name ? `Data profile ${GLYPHS.emDash} ${name}` : "Data profile";
        const runtime = harnessRuntime();
        const running = snap.kind === "loaded" && snap.profile.status === "running";
        const hasInputs =
            analysis !== null &&
            listAnalysisInputs(analysis.id).match(
                (xs) => xs.length > 0,
                () => false,
            );
        const canReprofile = bootState().phase === "ready" && !running && hasInputs;
        dialogPush(() => (
            <ResultsDialog
                title={title}
                lines={profileDetailLines(snap)}
                emptyText="no profile data"
                // Present the action only when a runtime + analysis exist to close over; `enabled`
                // gates whether it is actually offered (footer hint + key binding).
                action={
                    analysis && runtime
                        ? {
                              key: "r",
                              label: "re-profile",
                              enabled: canReprofile,
                              onAction: () => {
                                  void driveForceReprofile(runtime, analysis, () => workspace.analysis?.id ?? null);
                                  dialogClose();
                              },
                          }
                        : undefined
                }
                onClose={() => dialogClose()}
            />
        ));
    }

    // Open the RUNS flow — the runs picker → run-detail pair. Routed through the `runs.show`
    // command so the sidebar click, the leader chord, and the palette all share ONE open path
    // (the command's helper owns the fresh fetch and its pre-ready degrade).
    function openRuns(): void {
        runCommandById("runs.show");
    }

    // Open the TURN ERROR details view: the full cause of the last failed turn (stack, nested
    // `.cause`, the whole structured object) the one-line banner collapses. Snapshots the retained
    // cause as of open, mirroring `openProfile`/`openRuns`. Opening with nothing stored is fine — the
    // dialog shows its empty text. No footer action: this is a read-only inspection surface.
    function openTurnError(): void {
        dialogPush(() => (
            <ResultsDialog
                title="Turn error"
                lines={causeDetailLines(conversation.lastTurnFailure())}
                emptyText="no recent turn error"
                onClose={() => dialogClose()}
            />
        ));
    }

    // A text-selection drag released over a Sidebar Section fires its `onMouseUp` (→ open dialog) on the
    // SAME release the root `onMouseUp={copySelection}` handles — so a drag ending on DATA PROFILE/RUNS
    // would both copy AND pop the dialog. When a selection is live, treat the release as the tail of that
    // drag and suppress the open (mirrors the selection-aware ctrl+c guard above). Only the mouse path is
    // guarded: the leader keys below invoke the unguarded `openProfile`/`openRuns` — a deliberate ctrl+x
    // d/r keypress carries no drag context and should always open.
    function openProfileFromSidebar(): void {
        if (renderer.getSelection()?.getSelectedText()) return;
        openProfile();
    }
    function openRunsFromSidebar(): void {
        if (renderer.getSelection()?.getSelectedText()) return;
        openRuns();
    }

    // The single root keyboard handler that drives the keymap engine. Every binding below is a
    // declarative layer; the dispatcher picks the winner — no hand-branched if/else here.
    useKeymapRoot();

    // Three-way ctrl+c: dismiss dialog → abort stream → quit. Always active (no `mode` gate),
    // high priority so it wins over any modal binding that shares the chord.
    // A dialog may VETO its dismissal (busy prompt, dirty config). The first vetoed press stops
    // there — the veto blocks accidental dismissal and the dialog shows its own feedback; a quick
    // second press escalates past the stuck dialog to the next tier, keeping a panic exit within
    // two keystrokes.
    let lastVetoAt = 0;
    const VETO_ESCALATE_WINDOW_MS = 1500;
    useBindings(() => ({
        priority: 100,
        bindings: [
            {
                chord: resolveKeybind("app.abort"),
                run: () => {
                    if (dialogIsOpen()) {
                        // When text is selected inside a dialog, ctrl+c copies instead of dismissing —
                        // matches OpenCode's selection-aware behavior.
                        const selected = renderer.getSelection()?.getSelectedText();
                        if (selected) {
                            void writeClipboard(selected);
                            notify({ kind: "info", text: "Copied to clipboard" });
                            renderer.clearSelection();
                            return;
                        }
                        if (dialogClose("dismiss")) {
                            lastVetoAt = 0;
                            return;
                        }
                        const now = Date.now();
                        const escalate = now - lastVetoAt < VETO_ESCALATE_WINDOW_MS;
                        lastVetoAt = now;
                        if (!escalate) return;
                    }
                    if (chatStatus() === "busy") {
                        conversation.abort();
                        return;
                    }
                    void quit();
                },
            },
        ],
    }));

    // esc clears a live text selection — and nothing else. The layer config is the exported
    // `selectionClearLayer` factory (its full rationale lives on that export); registering it via a
    // thunk re-invokes it each keystroke so `enabled` re-reads the live selection. The render test
    // installs the SAME factory, so the two can never drift.
    useBindings(() => selectionClearLayer(renderer));

    function runCommandById(id: string): void {
        const cmd = commands.find((c) => c.id === id);
        if (cmd) void runCommand(cmd, workspace);
    }

    // Open the most recent openable artifact card in the transcript (the `o` binding). Covers the
    // dominant "the agent just showed me something" case with zero transcript-focus machinery; the
    // "Browse artifacts…" palette command reaches the long tail.
    function openLatestArtifact(): void {
        const latest = conversation.sessionOpenables()[0];
        if (!latest) {
            notify({ kind: "info", text: "No artifacts to open yet." });
            return;
        }
        openArtifact(latest.analysisId, latest.entry);
    }

    // True while an answer is in flight, passed to the prompt as `busy`: its action keys go inert and
    // the feedback input dims, so a second keypress cannot double-answer before the gateway resolves.
    const [answerBusy, setAnswerBusy] = createSignal(false);

    // Answer the head ask through the runtime gateway. `applied` drains the entry (the gateway's
    // terminal re-emit also reconciles the transcript card); a stale outcome (`not_found` /
    // `already_terminal`) still drains it with a notice — the ledger has already moved past this ask
    // and holding the prompt open would wedge the queue. A thrown answer (e.g. Postgres unreachable)
    // leaves the entry in place: the write failed, the ask may still be answerable, so the user can
    // retry rather than lose the decision. Bridged through ResultAsync so the harness throw becomes a
    // handled branch (neverthrow-first) rather than a bare try/catch.
    function answerAsk(askId: string, reply: AskReply): void {
        const gateway = harnessRuntime()?.askGateway;
        if (!gateway) return;
        setAnswerBusy(true);
        void ResultAsync.fromPromise(gateway.answer(askId, reply), (e): unknown => e).match(
            (outcome) => {
                setAnswerBusy(false);
                switch (outcome) {
                    case "applied":
                        // Echo the user's own typed reject feedback onto the transcript card. The gateway
                        // already carried it to the ledger and the model-facing denial; this is the only
                        // path that surfaces it to the user. Order-safe vs the gateway's terminal re-emit:
                        // noteAskFeedback and reconcileAskCard both spread the same card, so they converge.
                        if (reply.kind === "reject" && reply.feedback) conversation.noteAskFeedback(askId, reply.feedback);
                        settleAsk(askId);
                        return;
                    case "not_found":
                        notify({ kind: "info", text: "That approval is no longer pending." });
                        settleAsk(askId);
                        return;
                    case "already_terminal":
                        notify({ kind: "info", text: "That approval was already answered." });
                        settleAsk(askId);
                        return;
                    default: {
                        const _exhaustive: never = outcome;
                        throw new Error(`unhandled answer outcome: ${JSON.stringify(_exhaustive)}`);
                    }
                }
            },
            (cause) => {
                // Leave the entry queued — the write failed, so the ask may still be answerable.
                setAnswerBusy(false);
                notify({ kind: "error", text: `Could not answer the approval: ${describeCause(cause)}` });
            },
        );
    }

    // Focus choreography for the docked prompt, gated on a change of HEAD-ASK IDENTITY — never on queue
    // length. When a new head ask appears, move focus to the prompt's box so its target-gated keys
    // engage and the composer is blurred (gating submits during the busy turn); when the queue drains,
    // restore focus to the composer. The identity gate is load-bearing: `activeAsk()` also tracks the
    // queue length, so an enqueue BEHIND the head re-runs this effect — but the head prompt may hold a
    // focused feedback input mid-edit (in feedback mode its layer binds only esc), and refocusing the
    // outer box would blur that input and silently drop keystrokes. `focusedAskId` remembers the ask we
    // last focused, so a length change with an unchanged head is inert. The renderable is not focusable
    // synchronously — the established queueMicrotask ref pattern.
    let focusedAskId: string | null = null;
    createEffect(() => {
        const head = activeAsk();
        if (head) {
            if (head.askId !== focusedAskId) {
                focusedAskId = head.askId;
                queueMicrotask(() => promptRef?.focus());
            }
        } else if (focusedAskId !== null) {
            focusedAskId = null;
            queueMicrotask(() => textareaRef?.focus());
        }
    });

    // Per-palette selection highlight. Dark themes keep OpenTUI's native highlight (each cell's fg becomes
    // its selection bg) — vivid against their bright syntax; light themes invert into mush, so there we
    // flatten the bg to `bgActive` and leave the fg alone (each token keeps its syntax color). Applied on
    // mouse-DOWN, not the `selection` event which only fires on mouse-up — too late for the first drag
    // frame; walked over the tree because markdown's internal text/code children take no `selectionBg` prop.
    function applySelectionColors(): void {
        const bg = themeVariant() === "light" ? theme().bgActive : undefined;
        const visit = (r: Renderable): void => {
            // text/code/diff/textarea expose the setters, a box doesn't; the `in` guard makes the cast sound.
            if ("selectionBg" in r) {
                const sel = r as Renderable & { selectionBg: string | undefined; selectionFg: string | undefined };
                sel.selectionBg = bg; // undefined = native highlight; reassigned each call so a theme switch re-derives
                sel.selectionFg = undefined;
            }
            for (const child of r.getChildren()) visit(child);
        };
        visit(renderer.root);
    }

    // Copy-on-select (see TEXT-SELECTION-CLIPBOARD-REPORT.md): OpenTUI owns the selection, we just read,
    // write, toast, clear. On the root box so a release anywhere copies.
    // Unconditional for now — the report's Windows explicit-copy flag can become a config knob if asked.
    function copySelection(): void {
        const text = renderer.getSelection()?.getSelectedText();
        if (!text) return; // empty → a plain click, not a drag
        void writeClipboard(text); // best-effort, never rejects → notify optimistically
        notify({ kind: "info", text: "Copied to clipboard" });
        renderer.clearSelection();
    }

    // Base chat keys, live only in base mode: opening a dialog pushes MODE_MODAL (effect below),
    // which suspends this whole layer at once — the declarative replacement for `if (dialogOpen)`.
    // Each app key has a direct chord AND a `<leader>` sequence (the leader, ctrl+x by default,
    // begins a chord the which-key panel documents live). desc/group feed that panel.
    useBindings(() => ({
        mode: MODE_BASE,
        bindings: [
            { chord: resolveKeybind("app.command-palette"), run: () => dialogPush(() => <CommandPalette commands={commands} />) },
            { chord: resolveKeybind("app.toggle-sidebar"), run: () => setSidebarOpen((open) => !open) },
            { chord: resolveKeybind("plan.explore-steps"), run: () => runCommandById("plan.explore-steps") },
            {
                chord: leaderSeq("k"),
                run: () => dialogPush(() => <CommandPalette commands={commands} />),
                desc: "Command palette",
                group: "App",
            },
            { chord: leaderSeq("b"), run: () => setSidebarOpen((open) => !open), desc: "Toggle sidebar", group: "App" },
            { chord: leaderSeq("a"), run: () => runCommandById("analysis.switch"), desc: "Switch analysis", group: "Analysis" },
            { chord: leaderSeq("n"), run: () => runCommandById("analysis.new"), desc: "New analysis", group: "Analysis" },
            { chord: leaderSeq("d"), run: openProfile, desc: "Data profile", group: "Analysis" },
            { chord: leaderSeq("r"), run: openRuns, desc: "Runs", group: "Analysis" },
            { chord: leaderSeq("s"), run: () => runCommandById("session.switch"), desc: "Switch session", group: "Session" },
            { chord: leaderSeq("t"), run: () => runCommandById("view.theme"), desc: "Change theme", group: "View" },
            { chord: leaderSeq("e"), run: openTurnError, desc: "Turn error details", group: "App" },
            { chord: leaderSeq("q"), run: () => void quit(), desc: "Quit", group: "App" },
        ],
    }));

    // A focus-`target` layer: clear-input (ctrl+u) is live only while the chat textarea is focused —
    // the fine-grained complement to `mode`, so it never fires when a dialog input owns focus. esc
    // FOCUSES the stream's ScrollPane (NORMAL mode) — never a bare blur, so focus always lands on a
    // widget. The pane's own focus-gated layer (see ScrollPane) supplies the vim scroll keys.
    useBindings(() => ({
        mode: MODE_BASE,
        target: textareaRef,
        bindings: [
            { chord: resolveKeybind("app.clear-input"), run: () => textareaRef?.setText(""), desc: "Clear input", group: "Input" },
            { chord: KEYS.escape, run: () => scrollPaneRef?.focus(), desc: "Scroll mode (vim keys)", group: "Input" },
        ],
    }));

    // Up-arrow retracts the just-sent message back into the composer. The layer config is the exported
    // `retractLayer` factory (its full rationale lives on that export); registering it via a thunk
    // re-invokes it each keystroke so `enabled` re-reads the live buffer + retract window. The dispatch
    // test installs the SAME factory, so the two can never drift.
    useBindings(() => retractLayer({ target: textareaRef, conversation }));

    // NORMAL-mode companion layer, live while the stream's pane is focused: returning to INSERT is
    // chat-specific (dialog panes have no input to return to), so it lives here, not in ScrollPane.
    // esc while the pane is focused matches no binding and the native scrollbox handler has no
    // escape case — the deliberate no-op that keeps focus from ever landing nowhere. The shared
    // ctrl+u never clashes across the two layers: each is gated to a disjoint focus target.
    useBindings(() => ({
        mode: MODE_BASE,
        target: scrollPaneRef,
        bindings: [
            { chord: { key: "i" }, run: () => textareaRef?.focus(), desc: "Insert mode", group: "Input" },
            { chord: KEYS.enter, run: () => textareaRef?.focus(), desc: "Focus input", group: "Input" },
            { chord: resolveKeybind("artifact.open-latest"), run: openLatestArtifact, desc: "Open latest artifact", group: "Artifacts" },
        ],
    }));

    // Double-press interrupt. The layer config is the exported `interruptLayer` factory (its full
    // rationale lives on that export); registering it via a thunk re-invokes it each keystroke so
    // `enabled` re-reads the live busy/selection state. The dispatch test installs the SAME factory, so
    // the two can never drift.
    useBindings(() =>
        interruptLayer({
            target: scrollPaneRef,
            busy: () => chatStatus() === "busy",
            selectedText: () => renderer.getSelection()?.getSelectedText() ?? "",
            conversation,
        }),
    );

    // TODO(robustness): minimal slash-command stub — only quit aliases for now. Replace with a
    // proper registry (parser, help listing, extensible command map) when the slash system lands.
    const QUIT_ALIASES = new Set(["quit", "exit", "q", "bye", "ciao"]);

    async function handleSubmit() {
        const text = textareaRef?.editBuffer.getText().trim();
        if (!text) return;

        if (text.startsWith("/")) {
            const name = text.slice(1).split(/\s+/)[0]?.toLowerCase();
            if (name && QUIT_ALIASES.has(name)) {
                // A non-empty `text` was read off `textareaRef.editBuffer` above, so the ref is mounted.
                textareaRef!.setText("");
                if (chatStatus() === "busy") {
                    conversation.abort();
                    notify({ kind: "info", text: "Stream aborted — /quit again to exit" });
                    return;
                }
                renderer.destroy();
                await shutdown(0);
                return;
            }
        }

        if (chatStatus() === "busy") return;
        // Gate normal turns behind a ready runtime: before boot completes there is no conversation
        // agent to drive, so a submit is a no-op (return BEFORE clearing the buffer so a message typed
        // while booting survives to send once ready). The boot animation + gated input affordance
        // already tell the user why. Quit still works — the three-way ctrl+c chord and the /quit alias
        // above both bypass this gate.
        if (bootState().phase !== "ready") return;
        // A ready runtime is always analysis-scoped (boot only fires for an analysis chat), so this
        // guards an unreachable state rather than crashing on `analysis!.id`. Refuse the turn with an
        // error banner and keep the typed text (return before clearing the buffer).
        const analysis = workspace.analysis;
        if (!analysis) {
            conversation.setError("No analysis is open — cannot start a turn.");
            return;
        }
        // A non-empty `text` was read off `textareaRef.editBuffer` above, so the ref is mounted.
        textareaRef!.setText("");

        // The conversation store owns the request lifecycle (the turn-scoped AbortController + the
        // shared turn engine); the harness emit adapter writes the stream, so App only hands off the text.
        await conversation.send({ sessionId: workspace.sessionId, analysisId: analysis.id, userText: text });
    }

    // The failed message the boot gate surfaces in the chat column; `undefined` while merely booting.
    const bootFailureMessage = (): string | undefined => {
        const boot = bootState();
        return boot.phase === "failed" ? boot.message : undefined;
    };

    const statusState = (): { text: string; tone: "success" | "warn" | "error" } => {
        const boot = bootState();
        if (boot.phase === "failed") return { text: `${GLYPHS.cross} boot failed`, tone: "error" };
        // Until the runtime is ready (idle before the boot fires, or booting), no turn can run — show
        // the boot state rather than a misleading "ready". Once ready, the turn-scoped status wins.
        if (boot.phase !== "ready") return { text: `${GLYPHS.circleHalf} booting${GLYPHS.ellipsis}`, tone: "warn" };
        return chatStatus() === "busy"
            ? { text: `${GLYPHS.circleHalf} thinking${GLYPHS.ellipsis}`, tone: "warn" }
            : chatStatus() === "error"
              ? { text: `${GLYPHS.cross} error`, tone: "error" }
              : { text: `${GLYPHS.circle} ready`, tone: "success" };
    };

    // The interrupt affordance for the status bar's right hints region, derived from the live
    // `app.interrupt` binding + the armed signal so it can never drift from the real key: absent when idle
    // OR while the composer is focused (INSERT — the interrupt binding is pane-focus-gated and unreachable
    // there, so the hint would over-promise), the muted resting hint while a turn is busy in NORMAL mode,
    // and the accented "again to interrupt" form once a first press has armed the window. The gate + wording
    // live in the pure {@link interruptHintFor}. Passed to StatusBar as plain data — it stays domain-free.
    const interruptHint = (): { label: string; armed: boolean } | undefined =>
        interruptHintFor({
            busy: chatStatus() === "busy",
            insertMode: composerFocused(),
            armed: conversation.interruptArmed(),
            key: keybindLabel("app.interrupt"),
        });

    return (
        <WorkspaceContext.Provider value={workspace}>
            <box flexDirection="column" width="100%" height="100%" backgroundColor={theme().bg} onMouseDown={applySelectionColors} onMouseUp={copySelection}>
                {/* Header */}
                <StatusBar
                    title="inflexa"
                    subtitle={workspace.analysis?.name}
                    state={statusState()}
                    // The working directory is a wide-terminal-only affordance: at/above the breakpoint the
                    // rail and a comfortable chat both fit, so the path earns its space; below it the sidebar
                    // carries the path instead, so gating here keeps it on exactly one surface at any width.
                    path={dims().width >= size.breakpointWide ? contractHome(workspace.workingDir) : undefined}
                    hints={[keybindLabel("app.command-palette"), keybindLabel("app.toggle-sidebar"), keybindLabel("app.abort")]}
                    interruptHint={interruptHint()}
                />

                {/* Main row: the chat column beside the full-height sidebar. Showing the sidebar
                shrinks the chat column (stream + input together) — the opencode layout. */}
                <box flexDirection="row" flexGrow={1} minHeight={0} width="100%">
                    <box flexDirection="column" flexGrow={1} minHeight={0}>
                        {/* The live conversation: stream + error banner, all state in hooks/conversation.ts.
                        Live run progress renders in the sidebar RUNS section (not chat chrome) — a hidden
                        sidebar deliberately shows no live progress. */}
                        <Chat onScrollPaneRef={(r: ScrollBoxRenderable) => (scrollPaneRef = r)} />

                        {/* Boot animation / failed-boot message, shown until the runtime is ready. A
                        full-width box painted with the app background and flexShrink={0}: it sits
                        directly below the Chat stream's flexGrow scrollbox, so it must opaquely reclaim
                        its rows (the documented 1-cell scrollbox bleed) and keep them on a short
                        terminal — the Chat stream yields the squeeze instead. paddingLeft aligns it with
                        the stream content. */}
                        <Show when={bootState().phase === "booting" || bootState().phase === "failed"}>
                            <box width="100%" flexShrink={0} backgroundColor={theme().bg} paddingLeft={1} paddingRight={1}>
                                <BootIndicator message={bootFailureMessage()} />
                            </box>
                        </Show>

                        {/* Docked approval prompt — mounted only while an ask is pending, directly below the
                        Chat stream's flexGrow scrollbox. AskPrompt paints its own full-width flexShrink={0}
                        background row (the 1-cell scrollbox-bleed rule), so it opaquely reclaims its rows. It
                        docks here, never as a modal over the transcript, so the user can see what they are
                        approving. `keyed` mounts a FRESH prompt per head ask (choice/feedback mode resets and
                        the focus target is re-handed) as the queue advances. */}
                        <Show when={activeAsk()} keyed>
                            {(ask: PendingAsk) => (
                                <AskPrompt
                                    title={ask.title}
                                    command={ask.command}
                                    detail={ask.detail}
                                    queuedCount={queuedCount()}
                                    busy={answerBusy()}
                                    onApprove={(kind: "once" | "always") => answerAsk(ask.askId, { kind })}
                                    onReject={(feedback?: string) => answerAsk(ask.askId, { kind: "reject", ...(feedback ? { feedback } : {}) })}
                                    onFocusReady={(r: BoxRenderable) => (promptRef = r)}
                                />
                            )}
                        </Show>

                        {/* Input area — gated (submits refused, gate shown in the affordance) until boot is ready.
                        The gate reason distinguishes still-booting from a terminal boot failure so the
                        placeholder is honest; `ready` passes no gate (input open). */}
                        <ChatBar
                            gate={bootState().phase === "ready" ? undefined : bootState().phase === "failed" ? "failed" : "booting"}
                            onTextareaRef={(r: TextareaRenderable) => {
                                textareaRef = r;
                                queueMicrotask(() => r.focus());
                            }}
                            onSubmit={() => void handleSubmit()}
                            // Mirror the composer's focus (INSERT ↔ NORMAL) so `interruptHint` can gate on
                            // NORMAL mode — the SAME `onFocusChange` seam the ChatBar footer reads for its mode word.
                            onFocusChange={setComposerFocused}
                        />

                        {/* Transient toast (single slot, auto-dismissed). Inside the chat column, not the
                        root box, so it floats over the conversation and never the sidebar — opentui absolute
                        positioning is parent-relative. zIndex keeps it above an open modal. */}
                        <Show when={currentNotice()} keyed>
                            {(n: Notice) => (
                                <box
                                    position="absolute"
                                    top={1}
                                    right={2}
                                    zIndex={zIndex.toast}
                                    // A DEFINITE width (not maxWidth) so a long line wraps instead of clipping —
                                    // opentui only wraps text whose box has a resolved width; maxWidth sizes to the
                                    // text's single-line length and then clips the overflow (hiding a long export
                                    // path mid-string). Size to the text so short toasts stay snug, capped so a long
                                    // path wraps within the cap. +6 = border (2) + padding (2) + glyph and its space (2).
                                    width={Math.min(60, dims().width - 6, n.text.length + 6)}
                                    backgroundColor={theme().bgRaised}
                                    border
                                    borderColor={noticeColor(n.kind)}
                                    paddingLeft={1}
                                    paddingRight={1}
                                >
                                    <text fg={noticeColor(n.kind)}>
                                        {n.kind === "error" ? GLYPHS.cross : n.kind === "warn" ? GLYPHS.warning : GLYPHS.circle} {n.text}
                                    </text>
                                </box>
                            )}
                        </Show>
                    </box>

                    {/* Full-height sidebar: spans both the stream and the input; ctrl+b toggles it. */}
                    <Show when={sidebarOpen()}>
                        <Sidebar messageCount={conversation.messageCount} onOpenProfile={openProfileFromSidebar} onOpenRuns={openRunsFromSidebar} />
                    </Show>
                </box>

                {/* which-key: while a leader sequence is pending, lists the reachable next keys.
                Base-mode only, so it never overlaps a modal (a dialog suppresses base bindings). */}
                <WhichKey />

                {/* Dialog host: the module-level stack + overlay, extracted to dialog_host.tsx.
                A direct child of the full-screen root box (not a Portal — see dialog_host).
                Focus restore is uniform: some widget (textarea or scroll pane) is always focused
                when a dialog opens, so the saved focus is never null. */}
                <DialogOverlay />
            </box>
        </WorkspaceContext.Provider>
    );
}
