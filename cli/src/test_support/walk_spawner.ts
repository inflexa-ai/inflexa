import { ok } from "neverthrow";

import type { WalkSpawner } from "../modules/fs/search_index.ts";
import { readFolderEntries, walkToRecords, type ReadEntries, type WalkOpts } from "../modules/fs/walk_child.ts";

/** One child of {@link inProcessSpawner}: its arguments and the count of its kills. */
export type FakeChild = { scope: string; opts: WalkOpts; kills: number };

/**
 * A spawner that runs the walk of the child in the test process with `read`, and streams its records as the pipe of a
 * child does. Its kill counts the call and aborts the walk, as a `SIGKILL` ends the reads of a child.
 */
export function inProcessSpawner(read: ReadEntries = readFolderEntries): { spawn: WalkSpawner; children: FakeChild[] } {
    const children: FakeChild[] = [];
    const spawn: WalkSpawner = (scope, opts) => {
        const child: FakeChild = { scope, opts, kills: 0 };
        children.push(child);
        const abort = new AbortController();
        const pipe = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
        const stdout = new ReadableStream<Uint8Array>({
            start: (controller) => pipe.resolve(controller),
            cancel: () => abort.abort(),
        });
        void pipe.promise.then((controller) =>
            walkToRecords(
                scope,
                opts,
                read,
                (bytes) => {
                    if (!abort.signal.aborted) controller.enqueue(bytes);
                    return Promise.resolve();
                },
                abort.signal,
            ).match(
                () => {
                    if (!abort.signal.aborted) controller.close();
                },
                () => undefined,
            ),
        );
        return ok({
            stdout,
            kill: () => {
                child.kills += 1;
                abort.abort();
            },
        });
    };
    return { spawn, children };
}
