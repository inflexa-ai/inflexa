/**
 * The persisted shapes of the package-store domain: the transfer row and the
 * flight row. The shapes live here, not beside their lifecycles, because
 * `src/db/` reads and writes them, and the infrastructure never imports a
 * module. The lifecycles stay in `modules/libs/` (`transfers.ts`,
 * `store_flight.ts`), and they import these shapes like every other consumer.
 */

/** The three transfer kinds, in the order the surfaces render them. */
export const TRANSFER_KINDS = ["runtime_image", "provisioner_image", "catalog"] as const;

/** One of the three transfer kinds. */
export type TransferKind = (typeof TRANSFER_KINDS)[number];

/**
 * The lifecycle states of one transfer.
 *
 * `declined` records a setup answer of no, which starts no child and writes no
 * staged tree. `canceled` records a transfer that started and that the user
 * stopped. The difference is load-bearing: only the second has a partial tree
 * to drop. `failed`, `declined`, and `canceled` are terminal, and only a retry
 * leaves one of them.
 */
export type TransferStatus = "pending" | "running" | "installed" | "failed" | "declined" | "canceled";

/**
 * The part of the work a live transfer does right now.
 *
 * `download` moves the bytes, and `unpacking` writes the moved layers onto the
 * disk. The distinction does not ride the byte counters, because the last byte
 * lands before the unpacking starts. The word is `unpacking` and not `staging`,
 * because `staging` already names the farm swap and the analysis input root.
 */
export type TransferPhase = "download" | "unpacking";

/**
 * The one persisted row of a transfer kind.
 *
 * The row is the truth of what the CHILD does, and it decides nothing about
 * usability: an image or a store can arrive by a route that wrote no row, thus
 * an absent row is a normal condition. The receipt on disk (catalog) and the
 * engine (images) stay the truth of what the machine holds.
 */
export type TransferRow = {
    /** The kind, which is the whole identity of the row — one row per kind. */
    readonly id: TransferKind;
    /** When the first run wrote the row, epoch millis. */
    readonly createdAt: number;
    /** When the last write landed, epoch millis. */
    readonly updatedAt: number;
    /** The lifecycle state as WRITTEN. Read it through `readTransferReport` (`modules/libs/transfers.ts`), which corrects a dead holder. */
    readonly state: TransferStatus;
    /** The bytes the transfer has moved so far. Zero when only the CLI-pull fallback ran, which reports no byte figure. */
    readonly bytesTransferred: number;
    /** The bytes the source declares, or `null` when it declares none. */
    readonly totalBytes: number | null;
    /** The layers the transfer has completed so far. */
    readonly layersCompleted: number;
    /** The layers the source declares, or `null` when it declares none. */
    readonly totalLayers: number | null;
    /** What the last resolve saw: a manifest digest for the catalog, a local image digest for an image. */
    readonly digest: string | null;
    /** The user-facing message of a failure, or the notice of a completed run. Never a stack trace. */
    readonly message: string | null;
    /** The process identifier of the child, or `null` when no child holds the run. */
    readonly holderPid: number | null;
    /** The part of the work the child does now, or `null` when the row declares none — an image transfer, and a row an older binary wrote. */
    readonly phase: TransferPhase | null;
};

/** The package ecosystems a flight can acquire. The store carries the two tracks, and the key separates them. */
export type StoreEcosystem = "python" | "r";

/**
 * The states of one flight. `queued` is a flight that owns its key and waits
 * for a slot under the concurrency cap. `running` is a flight whose batch
 * container is up. `failed` is the ONE terminal state: a refused spec settles
 * into it with a durable message, and a retry of the same spec claims the row
 * back to `queued`. A success still removes its row — a completed state that
 * everyone has is noise.
 */
export type StoreFlightStatus = "queued" | "running" | "failed";

/** The persisted row of one live flight. */
export type StoreFlightRow = {
    /** The flight key: the ecosystem, the canonical name, and the specifier, joined. */
    readonly id: string;
    /** When the owner claimed the key, epoch millis. */
    readonly createdAt: number;
    /** When the last write landed, epoch millis. */
    readonly updatedAt: number;
    /** The live state. */
    readonly state: StoreFlightStatus;
    /** The ecosystem of the spec, or `null` for a name the run resolves. */
    readonly ecosystem: StoreEcosystem | null;
    /** The PEP 503 canonical distribution name. */
    readonly name: string;
    /**
     * The spelling the user gave, which the installer and every render need. An R
     * name is case-sensitive and can carry dots, thus the canonical form cannot
     * serve as an installer ref. A row from before the column backfills from `name`.
     */
    readonly rawName: string;
    /** The exact-version specifier, or empty. */
    readonly specifier: string;
    /** The newest provisioner line, or `null` before the container writes one. */
    readonly progress: string | null;
    /** The recorded reason of a `failed` flight: the phase, then the whole error text. `null` on a live row. */
    readonly message: string | null;
    /**
     * The process that owns the flight. A live row whose holder is dead is
     * debris that the next read sweeps. A `failed` row keeps the pid of its
     * ended flush, and the sweep keeps the row — the record must survive the
     * process.
     */
    readonly holderPid: number;
};
