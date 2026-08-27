/* eslint-disable solid/reactivity -- the dialog mounts once over one FIXED failed row (the opener
 * reads it fresh and passes it whole), so every `props.flight` read inside an action callback is a
 * deliberate one-time read — there is no later prop change to track. */
import { For } from "solid-js";
import type { JSX } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";

import { env } from "../../../lib/env.ts";
import { GLYPHS } from "../../../lib/design_system.ts";
import { writeClipboard } from "../../../lib/clipboard.ts";
import { deleteStoreFlight } from "../../../db/primary_mutation.ts";
import { collectStoreDebris, startPendingFlushChild } from "../../../modules/libs/store.ts";
import { describeRecordedFlightFailure, describeStoreFlightSpec, enqueueStoreAdd } from "../../../modules/libs/store_flight.ts";
import type { StoreFlightRow } from "../../../types/store.ts";
import { theme } from "../../theme.ts";
import { KEYS, chordLabel, parseChord } from "../../keymap.ts";
import { notify } from "../../hooks/notice.ts";
import { useDialogBindings, useDialogCancel, useDialogEntry } from "./dialog_host.tsx";
import { DialogPanel } from "./dialog_panel.tsx";
import { ScrollPane, SCROLL_HINT } from "../scroll_pane.tsx";

/**
 * Compose the detail lines of one failed flight: the identity, the phase as
 * one plain sentence, then the WHOLE recorded reason. The record renders
 * unabridged here — this dialog is the surface the bounded one-line renders
 * point at, so nothing may clamp it a second time.
 */
export function failedFlightDetailLines(row: StoreFlightRow): string[] {
    const lines = [`spec: ${describeStoreFlightSpec(row)}`, `reason: ${describeRecordedFlightFailure(row.message)}`, "", "the whole record:"];
    for (const raw of (row.message ?? "no reason was recorded").split("\n")) lines.push(`  ${raw}`);
    return lines;
}

/**
 * The detail view of one failed acquisition flight, opened from the sidebar
 * row or the command palette (the package-store-management spec).
 *
 * The three actions carry their own consent — the key push IS the approval,
 * exactly as a terminal `inflexa store add` is:
 * - copy puts the whole recorded reason on the clipboard, for a paste into
 *   the chat or an issue;
 * - retry enqueues the same spec and starts the detached flush, thus the
 *   claim flips this row back to `queued` and the failure clears with the
 *   outcome of the new flight;
 * - delete removes the row, and the silent debris pass frees the bytes that
 *   the failed acquisition left.
 */
export function FailedFlightDialog(props: { flight: StoreFlightRow; onClose: () => void }): JSX.Element {
    const dialog = useDialogEntry();
    useDialogCancel(() => props.onClose());

    function copyRecord(): void {
        void writeClipboard(props.flight.message ?? "");
        notify({ kind: "info", text: "Copied the recorded reason" });
    }

    function retryFlight(): void {
        const enqueued = enqueueStoreAdd({
            name: props.flight.name,
            version: props.flight.specifier.startsWith("==") ? props.flight.specifier.slice(2) : null,
            ecosystem: props.flight.ecosystem,
            analysisId: null,
        });
        enqueued.match(
            () => {
                startPendingFlushChild();
                notify({ kind: "info", text: `Retrying ${describeStoreFlightSpec(props.flight)} — the flight starts now` });
                props.onClose();
            },
            (error) => notify({ kind: "error", text: error.message }),
        );
    }

    function deleteRecord(): void {
        deleteStoreFlight(props.flight.id).unwrapOr(0);
        // Fire-and-forget: the pass yields to live work on its own, and a
        // pass that frees nothing is silent by design.
        void collectStoreDebris(env.packageStoreDir).then((collected) => collected.unwrapOr({ swept: false, dirs: [], reports: 0 }));
        notify({ kind: "info", text: `Removed the failed record of ${describeStoreFlightSpec(props.flight)}` });
        props.onClose();
    }

    const footer = (): string =>
        `${SCROLL_HINT} ${GLYPHS.middot} ${chordLabel(KEYS.escape)} close ${GLYPHS.middot} c copy ${GLYPHS.middot} r retry ${GLYPHS.middot} d delete`;

    useDialogBindings(() => ({
        bindings: [
            { chord: KEYS.q, run: () => props.onClose() },
            { chord: parseChord("c"), run: copyRecord },
            { chord: parseChord("r"), run: retryFlight },
            { chord: parseChord("d"), run: deleteRecord },
        ],
    }));

    return (
        <DialogPanel title={`failed ${GLYPHS.middot} ${describeStoreFlightSpec(props.flight)}`} size="lg" footer={footer()}>
            <ScrollPane focusOnMount={false} onRef={(r: ScrollBoxRenderable) => dialog?.setInitialFocus(r)} flexGrow={1} width="100%" paddingTop={1}>
                <For each={failedFlightDetailLines(props.flight)}>{(line) => <text fg={theme().fg}>{line}</text>}</For>
            </ScrollPane>
        </DialogPanel>
    );
}
