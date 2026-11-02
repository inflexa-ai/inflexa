/**
 * The DBOS event mocks that the workflow suites share: each one installs a method on the static DBOS object
 * and records into the state that the caller owns.
 */

import { mock } from "bun:test";

import { parseUnknownRecord } from "../../../lib/unknown-containers.js";

/** `DBOS.writeStream` records every emitted part that parses as a record. */
export async function dbosWriteStreamRecorder(emittedParts: unknown[]): Promise<void> {
    const dbos = await import("@dbos-inc/dbos-sdk");
    Reflect.set(
        dbos.DBOS,
        "writeStream",
        mock((_name: string, part: unknown) => {
            const written = parseUnknownRecord(part);
            if (written) emittedParts.push(written);
            return Promise.resolve(undefined);
        }),
    );
}

/** `DBOS.recv` records the topic of the wait, calls the resume hook, and answers with the resume message. */
export async function dbosRecvRecorder(
    state: { recvTopics: string[]; onRecv?: () => void },
    resumeMessage: unknown,
): Promise<void> {
    const dbos = await import("@dbos-inc/dbos-sdk");
    Reflect.set(
        dbos.DBOS,
        "recv",
        mock((topic: string) => {
            state.recvTopics.push(topic);
            state.onRecv?.();
            return Promise.resolve(resumeMessage);
        }),
    );
}
