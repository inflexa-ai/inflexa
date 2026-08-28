import { EventEmitter } from "events";
import { randomUUIDv7 } from "bun";
import type { BusEvent, StampedEvent } from "../types/events.ts";
import { getLogger } from "./log.ts";

class BusEmitter extends EventEmitter<{
    inflexa: [StampedEvent];
}> {
    override emit<E extends string | symbol>(
        eventName: keyof EventEmitter.EventEmitterEventMap | "inflexa" | E,
        ...args: E extends "inflexa"
            ? { inflexa: [BusEvent] }[E]
            : E extends keyof EventEmitter.EventEmitterEventMap
              ? EventEmitter.EventEmitterEventMap[E]
              : // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stdlib signature we are overriding
                any[]
    ): boolean {
        if (eventName === "inflexa" && args && args[0] && typeof args[0] === "object") {
            args[0].__infId = args[0].__infId ?? randomUUIDv7();
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- args is BusEvent on input but StampedEvent after __infId mutation
        return super.emit(eventName, ...(args as any));
    }
}

export const Bus = new BusEmitter();

let subscribed = false;

/**
 * Bulky payloads (command args, output lists) are deliberately reduced to identifiers
 * and counts — these records double as exportable telemetry events.
 */
function eventFields(event: StampedEvent): Record<string, unknown> {
    switch (event.type) {
        case "prov.analysis_created":
            return { analysisId: event.analysisId, actorKind: event.actor.kind };
        case "prov.input_added":
            return { analysisId: event.analysisId, actorKind: event.actor.kind, inputPath: event.input.path };
        case "prov.input_removed":
            return { analysisId: event.analysisId, actorKind: event.actor.kind, inputPath: event.input.path };
        case "prov.run_started":
            return { analysisId: event.analysisId, actorKind: event.actor.kind, runId: event.run.runId };
        case "prov.run_completed":
            return { analysisId: event.analysisId, actorKind: event.actor.kind, runId: event.outcome.runId, status: event.outcome.status };
        case "prov.step_completed":
            return {
                analysisId: event.analysisId,
                actorKind: event.actor.kind,
                runId: event.outcome.runId,
                stepId: event.outcome.stepId,
                status: event.outcome.status,
                model: event.model,
            };
        case "prov.command_executed":
            return {
                analysisId: event.analysisId,
                actorKind: event.actor.kind,
                runId: event.step.runId,
                stepId: event.step.stepId,
                // The command line for a command execution, the tool name for a file-tool write — the
                // one identifying string per producer kind, without carrying args into telemetry.
                command: event.command.kind === "command" ? event.command.command : event.command.tool,
                outputCount: event.command.outputs.length,
                model: event.model,
            };
        case "prov.file_written":
            return { analysisId: event.analysisId, actorKind: event.actor.kind, filePath: event.file.path, producer: event.file.producer };
        case "prov.input_used":
            return { analysisId: event.analysisId, actorKind: event.actor.kind, filePath: event.input.path, source: event.input.source };
        // The report family projects its identifying fields only: the thread, plus the block and its
        // kind, the version, or the path the member carries. Authored content stays out — the title
        // text and the block bodies are the user's report, not telemetry.
        case "prov.session_created":
            return {
                analysisId: event.analysisId,
                actorKind: event.actor.kind,
                threadId: event.session.threadId,
                sessionKind: event.session.kind,
                model: event.model,
            };
        case "prov.report_block_added":
        case "prov.report_block_changed":
        case "prov.report_block_removed":
        case "prov.report_block_moved":
            return {
                analysisId: event.analysisId,
                actorKind: event.actor.kind,
                threadId: event.block.threadId,
                blockId: event.block.blockId,
                // The kind says WHAT the act touched; a block id alone tells a reader nothing.
                blockKind: event.block.blockKind,
                model: event.model,
            };
        case "prov.report_title_set":
            // The title itself is authored report content, so only the thread it landed on rides.
            return { analysisId: event.analysisId, actorKind: event.actor.kind, threadId: event.title.threadId, model: event.model };
        case "prov.report_derivation_run":
            return {
                analysisId: event.analysisId,
                actorKind: event.actor.kind,
                threadId: event.derivation.threadId,
                outputPath: event.derivation.outputPath,
                sourceCount: event.derivation.sources.length,
                model: event.model,
            };
        case "prov.report_previewed":
            return {
                analysisId: event.analysisId,
                actorKind: event.actor.kind,
                threadId: event.preview.threadId,
                pagePath: event.preview.pagePath,
                model: event.model,
            };
        case "prov.report_version_recorded":
            return {
                analysisId: event.analysisId,
                actorKind: event.actor.kind,
                threadId: event.version.threadId,
                versionId: event.version.versionId,
                replaced: event.version.replaced,
                model: event.model,
            };
        case "run.observed":
            // The snapshot carries every step; telemetry keeps the shape as counts. A run of 40
            // steps observed on every transition would otherwise write the whole DAG to the log
            // dozens of times per run, which is the payload reduction this function exists for.
            return {
                analysisId: event.analysisId,
                runId: event.snapshot.runId,
                status: event.snapshot.status,
                stepCount: event.snapshot.steps.length,
                doneCount: event.snapshot.steps.filter((s) => s.status === "completed").length,
            };
    }
}

/**
 * Explicit init (not an import side effect) so importing Bus alone
 * never starts the tap.
 */
export function initBusLogging(): void {
    if (subscribed) return;
    subscribed = true;

    const log = getLogger("bus");
    Bus.on("inflexa", (event) => {
        log.info({ event: event.type, infId: event.__infId, ...eventFields(event) }, "bus event");
    });
}
