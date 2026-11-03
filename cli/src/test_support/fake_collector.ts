import type { ProvenanceCollector } from "@inflexa-ai/harness";

/**
 * The input and record shapes that the adapters read off the collector: the subset of the `InputRef` and
 * `ProvenanceRecord` of the harness that they touch. The barrel exports neither, thus these structural mirrors stand in.
 */
export type FakeInputRef = { path: string; hash: string; source: "data" | "upstream" | "prior" | "artifacts"; fileId?: string };
export type FakeProducer =
    | { type: "command"; command: string; args?: string[]; exitCode: number; durationMs?: number; timestamp: string }
    | { type: "file_tool"; tool: string; invocationId: string };
export type FakeRecord = { outputPath: string; producer: FakeProducer; inputs?: FakeInputRef[]; scriptPath?: string | null };

/**
 * A collector that answers `getRecords()` and `getTrackedInputs()`, the two members that the provenance adapter
 * reads. A structural stub is cleaner than the real class, whose private fields reject an object literal and whose
 * ingest methods need write fixtures. `producer` passes through by REFERENCE, thus a test forms a command group by
 * sharing one producer object across several records, which is how the real collector keys a multi-output command.
 */
export function fakeCollector(records: FakeRecord[] = [], trackedInputs: FakeInputRef[] = []): ProvenanceCollector {
    const recs = records.map((r) => ({ outputPath: r.outputPath, producer: r.producer, inputs: r.inputs ?? [], scriptPath: r.scriptPath ?? null }));
    // SAFETY: `ArtifactRegistrationInput.collector` is the harness class, which the barrel exports as a type only and which has private members, so no object literal satisfies it. The adapter reads only the two members of the stub, and the records of the stub carry the fields that it reads.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the class is harness-owned, exported as a type only, and the only members that the adapter reads are the two of the stub
    return { getRecords: () => recs, getTrackedInputs: () => trackedInputs } as ProvenanceCollector;
}
