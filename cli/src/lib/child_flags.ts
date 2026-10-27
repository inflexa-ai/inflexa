// The spellings of each hidden background child that the CLI starts for itself. The spawn sites, the command
// registry, and the start code of the entry read them from here, thus a spawn site cannot drift from the gate that
// recognizes its child. This module imports nothing: the registry and the entry load it at each start.

/** The hidden flag of `inflexa serve` that runs the detached child of `inflexa serve --detach`. */
export const SERVE_DETACHED_CHILD_FLAG = "--run-detached";

/**
 * The hidden flag that a client adds when it starts `inflexa serve --detach` for itself. The argv cannot otherwise
 * tell such a start from the `inflexa serve --detach` of a person, and the client start would read the update again,
 * thus the person would see the update notice two times. `serve` accepts the flag and ignores it.
 */
export const CLIENT_START_FLAG = "--for-client";

/**
 * The hidden flag that tells a re-invoked `inflexa sandbox pull` to run ONE image transfer in-process rather than
 * start children.
 */
export const IMAGE_TRANSFER_FLAG = "--run-transfer";

/**
 * The hidden flag that tells the re-invoked `inflexa store download` to move the bytes itself rather than start a
 * third process.
 */
export const CATALOG_TRANSFER_FLAG = "--run-transfer";

/**
 * The hidden flag that tells a re-invoked `inflexa store add` to run the flush of the pending set in-process. The chat
 * spawns exactly this when the asks of a turn settle.
 */
export const STORE_FLUSH_FLAG = "--run-flush";

/** The arguments that start the walk child of a search, before its scope and its flags. */
export const WALK_COMMAND = ["server", "walk"] as const;

const CHILD_FLAGS: ReadonlySet<string> = new Set([SERVE_DETACHED_CHILD_FLAG, CLIENT_START_FLAG, IMAGE_TRANSFER_FLAG, CATALOG_TRANSFER_FLAG, STORE_FLUSH_FLAG]);

/**
 * True when `args`, the arguments of this process after the executable and the entry, start a hidden background child
 * that the CLI starts for itself: the detached server, the `serve --detach` of a client, a transfer child, the flush child, or the walk child. Nobody
 * reads the output of such a child, thus it does no work for a person, for example the update read.
 *
 * `--queued` of `store add` is not here: the agent route passes it, not a spawn of the CLI. `inflexa up`, which the TUI
 * starts in the terminal of the person, is not here either: it is a command of a person.
 */
export function isSelfStartedChild(args: readonly string[]): boolean {
    if (args[0] === WALK_COMMAND[0] && args[1] === WALK_COMMAND[1]) return true;
    return args.some((arg) => CHILD_FLAGS.has(arg));
}
