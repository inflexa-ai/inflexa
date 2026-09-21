/**
 * The release a plan pins. The planner tools of one plan generation share
 * one pin: the first recommend answer sets it, and every later call of the
 * service inside that plan carries it as `expected_snapshot`. A service that
 * moved to another release between two calls then refuses the call, and the
 * plan never mixes two releases in silence.
 */

export interface SnapshotPin {
    /** The pinned release digest, or `undefined` before the first answer. */
    get(): string | undefined;
    /** Pin the release of the first answer. A later call with another digest changes nothing: the first release is the plan's. */
    set(digest: string): void;
}

export function createSnapshotPin(): SnapshotPin {
    let pinned: string | undefined;
    return {
        get: () => pinned,
        set: (digest) => {
            if (pinned === undefined) pinned = digest;
        },
    };
}
