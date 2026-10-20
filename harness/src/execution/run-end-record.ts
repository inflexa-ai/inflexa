import { z } from "zod";

import { RunStatus } from "../state/schema.js";

/**
 * The workflow event under which the body of `executeAnalysis` records its run
 * end after a failed status write. The run canceler reads it with
 * `DBOSClient.getEvent`.
 */
export const RUN_END_EVENT_KEY = "run-end";

/**
 * The run end that the body did: the status and the error that its failed
 * status write tried to write, and the results of the charge close and of the
 * revoke.
 */
export const RecordedRunEndSchema = z.object({
    status: RunStatus.exclude(["running"]),
    error: z.string().nullable(),
    closed: z.boolean(),
    revoked: z.boolean(),
});
export type RecordedRunEnd = z.infer<typeof RecordedRunEndSchema>;

/**
 * The engine hands back deserialized data, thus a value of an event is unknown
 * until this check. A value of the wrong shape gives `null`.
 */
export function parseRecordedRunEnd(value: unknown): RecordedRunEnd | null {
    const parsed = RecordedRunEndSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}
