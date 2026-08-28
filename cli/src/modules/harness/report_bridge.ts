import type { ProvenanceExport, ReportObservationEvent } from "@inflexa-ai/harness";

import { getAnalysisProvenance } from "../../db/primary_query.ts";
import { Bus } from "../../lib/bus.ts";
import { getLogger } from "../../lib/log.ts";
import type { ProvModelId } from "../../types/prov.ts";
import { flushProvenanceAsync, systemActor } from "../prov/prov.ts";
import { buildAttestation } from "../prov/verify.ts";

// The cli↔harness REPORT bridge: the two report seams over ONE analysis document. The emit half turns
// each observed act into a `prov.*` bus member, which the recorder appends to the signed document. The
// read half gives that same document back, for the page of a preview.
//
// The two halves share a file because they share a subject: the read hands out exactly what the emit
// half recorded, thus a change of the record family meets its reader in the same place. The run bridge
// stays apart from the provenance bridge for the opposite reason — a lossy presentation channel and a
// signed hash chain answer to different masters, and one file would invite one payload.
//
// Both halves import their own infrastructure, as `run_bridge.ts` does. The composition root binds the
// two functions and threads nothing else through.

const log = getLogger("harness:report");

/**
 * The live provenance name of the model that drives a report session, as `{provider}/{model}`.
 *
 * A function and not a value, because a person can change the model of the conversation agent while the
 * runtime runs. The bridge reads the name at each emit, thus every act names the model that did it.
 */
export type ReportSessionModel = () => ProvModelId;

// The one installed source. A process runs one embedded runtime, thus one source. It is a module
// singleton and not a parameter of the emit, because the composition root and the chat-turn engine must
// reach ONE seam: a second binding would be a second, and possibly different, claim about the model.
// The gauge of the agent switch, which the turn engine reaches the same way, has the same shape.
let sessionModel: ReportSessionModel | null = null;

/**
 * Install the source of the live session model, or clear it with `null`.
 *
 * The boot installs it beside the agent switch that it reads. A second install replaces the first, thus
 * a re-boot needs no teardown of its own.
 */
export function installReportSessionModel(read: ReportSessionModel | null): void {
    sessionModel = read;
}

/** The four block acts name four different bus members, and they carry one payload shape. */
type ReportBlockMember = "prov.report_block_added" | "prov.report_block_changed" | "prov.report_block_removed" | "prov.report_block_moved";

/**
 * Realize the harness's `emitReportObservation` seam as bus emission: map each observed act of a report
 * session onto its `prov.*` member, stamped with the system actor and the live session model.
 *
 * The agent does each of these acts, thus the record names the system actor and carries the model on
 * whose behalf it acted — the same treatment a model-driven step gets. The model is read at emit time,
 * thus a live agent switch re-stamps every later act, exactly as a swap re-stamps the run emitters.
 *
 * The mapping restates each payload into the cli's own ref types instead of forwarding the harness
 * object. Thus a widened seam shape fails to compile here, and it never reaches a subscriber unannounced.
 *
 * Fire-and-forget, which is what the harness guard expects: this gives no result, and the harness logs
 * anything that a subscriber propagates, thus a defect here never undoes the act that already landed.
 */
export function emitReportObservation(event: ReportObservationEvent): void {
    const live = sessionModel?.();
    if (live === undefined) {
        // A report record names the model that did the act. With no live name the bridge cannot make
        // that claim, and an invented name in a signed document is worse than a missing record. Thus the
        // record is dropped and the log keeps the fact. A tool reaches this seam through a booted
        // runtime alone, and that boot installs the source.
        log.warn({ event: event.type, analysisId: event.analysisId }, "no live session model; report record dropped");
        return;
    }
    // One name for the whole mapping, declared without the absent half, because the block helper below
    // reads it inside its own body and a narrowing does not reach there.
    const model: ProvModelId = live;
    const actor = systemActor();
    const analysisId = event.analysisId;

    // The thread and the block ride in as arguments, because the narrowing of the switch below does not
    // reach into this body.
    function emitBlockAct(type: ReportBlockMember, threadId: string, blockId: string): void {
        Bus.emit("inflexa", { type, analysisId, actor, model, block: { threadId, blockId } });
    }

    switch (event.type) {
        case "create-session":
            Bus.emit("inflexa", {
                type: "prov.session_created",
                analysisId,
                actor,
                model,
                session: {
                    threadId: event.threadId,
                    kind: event.sessionKind,
                    // A root session has no parent, thus the key stays absent rather than carrying
                    // `undefined` into the record.
                    ...(event.parentThreadId !== undefined ? { parentThreadId: event.parentThreadId } : {}),
                },
            });
            return;
        case "add-block":
            emitBlockAct("prov.report_block_added", event.threadId, event.blockId);
            return;
        case "change-block":
            emitBlockAct("prov.report_block_changed", event.threadId, event.blockId);
            return;
        case "remove-block":
            emitBlockAct("prov.report_block_removed", event.threadId, event.blockId);
            return;
        case "move-block":
            emitBlockAct("prov.report_block_moved", event.threadId, event.blockId);
            return;
        case "set-title":
            Bus.emit("inflexa", { type: "prov.report_title_set", analysisId, actor, model, title: { threadId: event.threadId, title: event.title } });
            return;
        case "run-derivation":
            Bus.emit("inflexa", {
                type: "prov.report_derivation_run",
                analysisId,
                actor,
                model,
                derivation: {
                    threadId: event.threadId,
                    outputPath: event.outputPath,
                    outputHash: event.outputHash,
                    scriptHash: event.scriptHash,
                    // Copied pair by pair, so nothing that the tool still holds reaches a subscriber.
                    sources: event.sources.map((s) => ({ path: s.path, hash: s.hash })),
                },
            });
            return;
        case "preview":
            Bus.emit("inflexa", {
                type: "prov.report_previewed",
                analysisId,
                actor,
                model,
                preview: { threadId: event.threadId, pagePath: event.pagePath, documentHash: event.documentHash },
            });
            return;
        case "record-version":
            Bus.emit("inflexa", {
                type: "prov.report_version_recorded",
                analysisId,
                actor,
                model,
                version: { threadId: event.threadId, versionId: event.versionId, replaced: event.replaced },
            });
            return;
        default: {
            // Exhaustiveness: a new observation member must add its mapping here.
            const never: never = event;
            throw new Error(`unhandled report observation event: ${JSON.stringify(never)}`);
        }
    }
}

/**
 * Realize the harness's `readReportProvenance` seam: give the stored provenance document of an analysis,
 * with a fresh attestation over the exact bytes that the page carries.
 *
 * The recorder writes the column on a debounced flush, thus a preview that reads at once would miss the
 * acts of the session that asks for it. The drain closes that window, and it costs one flush for each
 * preview.
 *
 * The read goes to the stored column, and not through the export helper of the prov module. That helper
 * seeds a fresh document when the column is unset, and it then gives bytes that no signature covers. A
 * document with no proof must not reach a page. The column holds the bytes that the chain hash covers,
 * thus the attestation over them matches the document that the page carries.
 *
 * Absence is a normal result and never an error: a vanished analysis row, an analysis whose column is
 * still null, and a failed attestation build all give nothing, and the page then renders with no
 * provenance asset. The last of the three is a fault, thus it also reaches the log.
 */
export async function readReportProvenance(analysisId: string): Promise<ProvenanceExport | undefined> {
    await flushProvenanceAsync();

    const document = getAnalysisProvenance(analysisId).match(
        (json) => json,
        (e) => {
            log.error({ analysisId, err: e.type, cause: e.cause }, "failed to read the stored provenance; the page gets none");
            return null;
        },
    );
    if (document === null) return undefined;

    const attestation = await buildAttestation(document);
    if (attestation.isErr()) {
        log.error({ analysisId, err: attestation.error.type }, "failed to build the attestation; the page gets no provenance");
        return undefined;
    }
    return { document, attestation: JSON.stringify(attestation.value) };
}
