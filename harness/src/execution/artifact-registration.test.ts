/**
 * `registerStepArtifacts` — a registry's severity verdict is recorded, not trusted.
 *
 * A registry may keep a rejection out of `failed`/`failedCount` when it was
 * never attempted and no bytes are at risk. That judgement is the registry's to
 * make; the record of it is not. The seam is implementable by an embedder, so
 * the harness logs whatever comes back in `notCounted` rather than leaving the
 * only account of a rejection to whichever implementation happens to be wired.
 */

import { describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { createCapturingLogger } from "../__tests__/setup/logger.js";
import type { AgentSession } from "../auth/types.js";
import { ProvenanceCollector } from "../provenance/collector.js";
import type { ArtifactManifestEntry } from "../schemas/artifact-manifest.js";
import { registerStepArtifacts } from "./artifact-registration.js";
import type { ArtifactRegistry, ExternalRegistrationResult } from "./artifact-registry.js";

const RID = "an-1";
const RUN = "run-1";
const STEP = "s1";
const OUT = `runs/${RUN}/${STEP}/output/out.csv`;
const HASH = `sha256:${"a".repeat(64)}`;

/** Every write this module makes is fire-and-forget SQL, and none of it is read back. */
const stubDb = (): Pool => ({ query: async () => ({ rows: [], rowCount: 0 }) }) as unknown as Pool;

const manifest = (): ArtifactManifestEntry[] => [
    { stepId: STEP, runId: RUN, path: "output/out.csv", size: 40, type: "output", hash: HASH },
];

const registryReturning = (result: ExternalRegistrationResult): ArtifactRegistry =>
    ({ register: async () => result, sync: async () => {} }) as unknown as ArtifactRegistry;

const run = async (result: ExternalRegistrationResult) => {
    const logger = createCapturingLogger();
    const registration = await registerStepArtifacts(
        stubDb(),
        registryReturning(result),
        { resourceId: RID, runId: RUN, stepId: STEP, artifacts: manifest(), collector: new ProvenanceCollector({ stepId: STEP, runId: RUN }) },
        {} as AgentSession,
        logger,
    );
    const rejectionWarnings = logger.records.filter(
        (r) => r.level === "warn" && r.msg.includes("excluded from the failure count"),
    );
    return { registration, rejectionWarnings };
};

const accepted = { registered: [{ path: OUT, externalId: "a-1" }], failed: [], failedCount: 0 };

describe("registerStepArtifacts — uncounted rejections", () => {
    it("logs a rejection the registry excluded, without failing the step over it", async () => {
        const { registration, rejectionWarnings } = await run({
            ...accepted,
            notCounted: [{ path: "data/unused.csv", error: "ArtifactNotReferencedError" }],
        });

        // The step's verdict is untouched: nothing was attempted, so nothing is at risk.
        expect(registration.externalFailed).toBe(0);
        expect(registration.failureDetails).toEqual([]);
        expect(registration.externalRegistered).toBe(1);

        // ...but the rejection is on the record, with enough to check the verdict
        // against what the external system actually said.
        expect(rejectionWarnings).toHaveLength(1);
        expect(rejectionWarnings[0]!.fields.rejected).toEqual([
            { path: "data/unused.csv", error: "ArtifactNotReferencedError" },
        ]);
        // Bound context, so the line is attributable without reading around it.
        expect(rejectionWarnings[0]!.fields).toMatchObject({ runId: RUN, stepId: STEP });
    });

    it("says nothing when the registry excluded nothing", async () => {
        const { rejectionWarnings } = await run(accepted);
        expect(rejectionWarnings).toEqual([]);
    });

    it("treats an empty exclusion list as nothing to say", async () => {
        const { rejectionWarnings } = await run({ ...accepted, notCounted: [] });
        expect(rejectionWarnings).toEqual([]);
    });

    it("leaves a terminal rejection counted and detailed, alongside an excluded one", async () => {
        const { registration, rejectionWarnings } = await run({
            registered: [],
            failed: [{ path: OUT, error: "leaf transaction rolled back" }],
            failedCount: 1,
            notCounted: [{ path: "data/unused.csv", error: "ArtifactNotReferencedError" }],
        });

        // The fail-fast message is built from `failureDetails`, so the harmless
        // rejection must not appear there next to the one that cost the step.
        expect(registration.externalFailed).toBe(1);
        expect(registration.failureDetails).toEqual([{ path: OUT, error: "leaf transaction rolled back" }]);
        expect(rejectionWarnings).toHaveLength(1);
    });
});
