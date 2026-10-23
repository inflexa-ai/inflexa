/**
 * The one route by which a surface that reads no skill learns which datasets a capability needs.
 * Two properties carry the weight: an absent entry is a catalog id (an install takes an id, not a
 * description), and an unreadable store answers UNKNOWN rather than absent (otherwise a store that
 * declines to answer would have the agent offer to install data that is already there).
 */

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { capabilityDataRequirement, declaredDataRequirements } from "../../agents/sandbox-catalog.js";
import { makeSession } from "../../providers/__fixtures__/session.js";
import { REFERENCE_DATA_CATALOG } from "../../reference-data/catalog.js";
import { REFERENCE_INSTALL_RECEIPT_VERSION, referenceReceiptContentDigest } from "../../reference-data/receipt.js";
import { createInspectCapabilityDataTool } from "../capability-data.js";
import type { ToolContext } from "../define-tool.js";

const SAFETY_AGENT = "translational-safety-agent";
const CAPABILITY = declaredDataRequirements().find((entry) => entry.agentId === SAFETY_AGENT)!.capability;
const DECLARED = [...capabilityDataRequirement(SAFETY_AGENT, CAPABILITY)].sort();

function toolContext(): ToolContext {
    return {
        invocationId: "tool-call-test",
        session: makeSession({ scope: { kind: "analysis", analysisId: "analysis-001" }, agentId: "conversation-agent", callPath: ["conversation-agent"] }),
        signal: new AbortController().signal,
        emit: () => {},
        ask: async () => {
            throw new Error("ask should not be reached");
        },
    };
}

/** A store whose receipts report exactly `ids` as installed. */
async function storeWith(ids: readonly string[]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "capdata-"));
    const receipts = join(root, ".inflexa", "receipts");
    await mkdir(receipts, { recursive: true });
    for (const id of ids) {
        const dataset = REFERENCE_DATA_CATALOG.datasets.find((candidate) => candidate.id === id)!;
        const content = {
            datasetId: id,
            datasetVersion: dataset.version,
            artifacts: dataset.artifacts.map((artifact) => ({ path: artifact.path, bytes: 1, sha256: "a".repeat(64) })),
        };
        await writeFile(
            join(receipts, `${id}.json`),
            JSON.stringify({
                version: REFERENCE_INSTALL_RECEIPT_VERSION,
                ...content,
                activatedAt: "2026-01-01T00:00:00Z",
                contentDigest: referenceReceiptContentDigest(content),
            }),
        );
    }
    return root;
}

async function answerFor(refStorePath: string) {
    const result = await createInspectCapabilityDataTool({ refStorePath }).execute({}, toolContext());
    return result._unsafeUnwrap();
}

describe("inspect_capability_data", () => {
    it("names every absent dataset of a capability by its catalog id", async () => {
        const answer = await answerFor(await storeWith([]));

        const row = answer.rows.find((candidate) => candidate.agentId === SAFETY_AGENT)!;
        expect(answer.storeReadable).toBe(true);
        expect([...row.absent]).toEqual(DECLARED);
        expect(row.installed).toEqual([]);
        for (const dataset of DECLARED) expect(answer.content).toContain(dataset);
    });

    it("separates the installed from the absent", async () => {
        const answer = await answerFor(await storeWith(DECLARED.slice(0, 2)));

        const row = answer.rows.find((candidate) => candidate.agentId === SAFETY_AGENT)!;
        expect([...row.installed]).toEqual(DECLARED.slice(0, 2));
        expect([...row.absent]).toEqual(DECLARED.slice(2));
    });

    it("reports nothing absent once every declared dataset is installed", async () => {
        const answer = await answerFor(await storeWith(DECLARED));

        const row = answer.rows.find((candidate) => candidate.agentId === SAFETY_AGENT)!;
        expect(row.absent).toEqual([]);
        expect([...row.installed]).toEqual(DECLARED);
    });

    it("answers UNKNOWN for an unreadable store, and claims no dataset is absent", async () => {
        const answer = await answerFor(join(tmpdir(), "no-such-capability-store"));

        expect(answer.storeReadable).toBe(false);
        expect(answer.content).toContain("UNKNOWN");
        expect(answer.content).not.toContain("absent:");
    });

    it("names the capability phrase, so a caller can put it on a plan step", async () => {
        const answer = await answerFor(await storeWith([]));

        expect(answer.content).toContain(CAPABILITY);
    });
});
