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
            };
        case "prov.file_written":
            return { analysisId: event.analysisId, actorKind: event.actor.kind, filePath: event.file.path, producer: event.file.producer };
        case "prov.input_used":
            return { analysisId: event.analysisId, actorKind: event.actor.kind, filePath: event.input.path, source: event.input.source };
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
