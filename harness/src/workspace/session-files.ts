/**
 * The files that a session writes outside a run, and the host hook that keeps a copy of each.
 *
 * A run registers its step files through `ArtifactRegistry`. A chat thread and a report session write files too:
 * the scripts and the derived files of `run_script`, and the files of `write_file` and `edit_file`. A host that
 * keeps the files of an analysis elsewhere binds `syncSessionFile`, and each write reaches it with its bytes. The
 * call runs inside the tool step of the write, thus a step that runs again after a crash calls the hook again with
 * the same file.
 */

import type { ResultAsync } from "neverthrow";

import type { AgentSession } from "../auth/types.js";
import { deliverNotice, type NoticeFailure } from "../lib/hooks.js";
import type { Logger } from "../lib/logger.js";

/** Who owns a session file. A file in the scratch directory of a thread belongs to that thread. */
export type SessionFileOwner = { readonly kind: "thread"; readonly threadId: string } | { readonly kind: "analysis" };

export type SessionFileWrite = {
    /** The session of the tool call that wrote the file. */
    readonly session: AgentSession;
    readonly owner: SessionFileOwner;
    /** The analysis-relative path, and the hash and the size of the bytes. */
    readonly path: string;
    readonly hash: string;
    readonly size: number;
    /** The exact bytes that landed. */
    readonly content: Uint8Array;
};

/** A notice: a failure is logged, and the write stays done. */
export type SyncSessionFile = (write: SessionFileWrite) => ResultAsync<void, NoticeFailure>;

/** Give one landed write to the hook of the host. An unbound hook does nothing. */
export async function syncWrittenFile(sync: SyncSessionFile | undefined, logger: Logger, write: SessionFileWrite): Promise<void> {
    if (sync === undefined) return;
    await deliverNotice(logger.with({ analysisId: write.session.scope.analysisId, path: write.path }), "syncSessionFile", sync(write));
}
