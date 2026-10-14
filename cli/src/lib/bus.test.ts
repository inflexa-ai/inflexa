import { describe, expect, test } from "bun:test";

import { Bus, initBusLogging } from "./bus.ts";
import { addLogStream, flushLogs } from "./log.ts";

type LogRecord = { event?: string; [field: string]: unknown };

/**
 * Capture the records of one bus event while `run` executes. `addLogStream` has no remover and the suite
 * shares one process, thus the stream stays attached, but it keeps a line only while a capture is open and
 * only for the named event. The capture holds at most the records of that event from that window.
 */
async function captureBusRecords(event: string, run: () => void): Promise<LogRecord[]> {
    const records: LogRecord[] = [];
    let open = true;
    addLogStream({
        write(chunk: string): void {
            if (!open) return;
            // The logger writes one JSON object per record, and the test reads only the `event` field and the projected fields, so the cast cannot admit a wrong shape.
            const record = JSON.parse(chunk) as LogRecord;
            if (record.event === event) records.push(record);
        },
    });
    initBusLogging();
    try {
        run();
        await flushLogs();
    } finally {
        open = false;
    }
    return records;
}

describe("the bus telemetry projection", () => {
    test("a plan approval surfaces the thread id, the plan id, and the run id, and the actor kind", async () => {
        const [record, ...others] = await captureBusRecords("prov.plan_approved", () =>
            Bus.emit("inflexa", {
                type: "prov.plan_approved",
                analysisId: "a1",
                actor: { kind: "user", id: "person@example.com", email: "person@example.com" },
                approval: { threadId: "t1", planId: "pln-0000000a", runId: "r1", approvedAtMs: 1_700_000_000_000 },
            }),
        );

        expect(others).toEqual([]);
        expect(record).toMatchObject({ analysisId: "a1", actorKind: "user", threadId: "t1", planId: "pln-0000000a", runId: "r1" });
        expect(record).not.toHaveProperty("email");
    });
});
