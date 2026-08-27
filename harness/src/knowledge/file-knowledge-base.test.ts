import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { makeSession } from "../providers/__fixtures__/session.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { loadFileKnowledgeBase } from "./file-knowledge-base.js";
import { createNoopKnowledgeBase } from "./noop-knowledge-base.js";
import { withKnowledgeObservation, type KnowledgeConsultation } from "./observe.js";

const session = makeSession();

const RULE = (id: string, severity: "reject" | "warn" | "note", applies: object = {}): object => ({
    id,
    title: `Rule ${id}`,
    applies,
    effect: { severity, statement: `Statement of ${id}.` },
    evidence: { sources: [{ citation: "A citation", doi: "10.1000/x" }] },
    version: "1.0.0",
});

async function writeCorpus(rules: object[], manifest?: object): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "knowledge-corpus-"));
    await mkdir(join(dir, "rules"), { recursive: true });
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest ?? { corpusId: "test-corpus", version: "0.9.0", ruleFiles: ["rules/all.json"] }));
    await writeFile(join(dir, "rules", "all.json"), JSON.stringify(rules));
    return dir;
}

/** A logger that counts warns, for the exclusion assertions. */
function countingLogger(): { logger: Logger; warns: () => number } {
    let count = 0;
    const base = createNoopLogger();
    const logger: Logger = {
        ...base,
        warn: () => {
            count += 1;
        },
        named: () => logger,
        with: () => logger,
    };
    return { logger, warns: () => count };
}

describe("loadFileKnowledgeBase", () => {
    test("a valid corpus loads and serves facts-filtered matches", async () => {
        const dir = await writeCorpus([
            RULE("INFLEXA-R-000001", "reject", { omicsType: ["transcriptomics"], minGroupN: { lt: 2 } }),
            RULE("INFLEXA-R-000002", "note", { omicsType: ["proteomics"] }),
            RULE("INFLEXA-R-000003", "warn"),
        ]);
        const kb = (await loadFileKnowledgeBase({ dir }))._unsafeUnwrap();
        expect(kb.describeCorpus()).toEqual({ corpusId: "test-corpus", version: "0.9.0" });

        const result = (await kb.findRules({ facts: { omicsType: "transcriptomics", minGroupN: 1 } }, session))._unsafeUnwrap();
        const ids = result.matches.map((m) => m.rule.id);
        expect(ids).toEqual(["INFLEXA-R-000001", "INFLEXA-R-000003"]);
        expect(result.matches[0]?.applicability).toBe("applies");
    });

    test("an unknown group size gives a not_evaluable match, never an exclusion", async () => {
        const dir = await writeCorpus([RULE("INFLEXA-R-000001", "reject", { omicsType: ["transcriptomics"], minGroupN: { lt: 2 } })]);
        const kb = (await loadFileKnowledgeBase({ dir }))._unsafeUnwrap();
        const result = (await kb.findRules({ facts: { omicsType: "transcriptomics" } }, session))._unsafeUnwrap();
        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]?.applicability).toBe("not_evaluable");
    });

    test("an invalid record is excluded and the valid records still load", async () => {
        const { logger, warns } = countingLogger();
        const dir = await writeCorpus([
            RULE("INFLEXA-R-000001", "note"),
            {
                id: "INFLEXA-R-000002",
                title: "No evidence",
                applies: {},
                effect: { severity: "note", statement: "x" },
                evidence: { sources: [{ citation: "no locator" }] },
                version: "1",
            },
        ]);
        const kb = (await loadFileKnowledgeBase({ dir, logger }))._unsafeUnwrap();
        const result = (await kb.findRules({}, session))._unsafeUnwrap();
        expect(result.matches.map((m) => m.rule.id)).toEqual(["INFLEXA-R-000001"]);
        expect(warns()).toBe(1);
    });

    test("a duplicate id keeps the first record and reports the second", async () => {
        const { logger, warns } = countingLogger();
        const dir = await writeCorpus([RULE("INFLEXA-R-000001", "warn"), RULE("INFLEXA-R-000001", "note")]);
        const kb = (await loadFileKnowledgeBase({ dir, logger }))._unsafeUnwrap();
        const lookup = (await kb.getRule("INFLEXA-R-000001", session))._unsafeUnwrap();
        expect(lookup.found && lookup.rule.effect.severity).toBe("warn");
        expect(warns()).toBe(1);
    });

    test("a missing manifest refuses with a typed error", async () => {
        const dir = await mkdtemp(join(tmpdir(), "knowledge-empty-"));
        const error = await loadFileKnowledgeBase({ dir }).match(
            () => null,
            (e) => e,
        );
        expect(error?.type).toBe("knowledge_corpus_unreadable");
    });

    test("an unknown rule id is a data variant", async () => {
        const dir = await writeCorpus([RULE("INFLEXA-R-000001", "note")]);
        const kb = (await loadFileKnowledgeBase({ dir }))._unsafeUnwrap();
        const lookup = (await kb.getRule("INFLEXA-R-999999", session))._unsafeUnwrap();
        expect(lookup).toEqual({ found: false, id: "INFLEXA-R-999999" });
    });

    test("a text query filters by keyword", async () => {
        const dir = await writeCorpus([RULE("INFLEXA-R-000001", "note"), RULE("INFLEXA-R-000002", "note")]);
        const kb = (await loadFileKnowledgeBase({ dir }))._unsafeUnwrap();
        const result = (await kb.findRules({ text: "INFLEXA-R-000002" }, session))._unsafeUnwrap();
        expect(result.matches.map((m) => m.rule.id)).toEqual(["INFLEXA-R-000002"]);
    });
});

describe("the shipped corpus", () => {
    // harness/src/knowledge → the repository root is three levels up.
    const shippedDir = resolve(import.meta.dir, "../../../knowledge");

    test("every shipped record validates and loads", async () => {
        const { logger, warns } = countingLogger();
        const kb = (await loadFileKnowledgeBase({ dir: shippedDir, logger }))._unsafeUnwrap();
        expect(warns()).toBe(0);
        expect(kb.describeCorpus().corpusId).toBe("inflexa-knowledge");
        const all = (await kb.findRules({ topK: 50 }, session))._unsafeUnwrap();
        expect(all.matches.length).toBeGreaterThanOrEqual(13);
    });

    test("the small-sample DE rule applies at one sample for each group, with reject severity", async () => {
        const kb = (await loadFileKnowledgeBase({ dir: shippedDir }))._unsafeUnwrap();
        const result = (await kb.findRules({ facts: { omicsType: "transcriptomics", omicsSubtype: "bulk-rna-seq", minGroupN: 1 } }, session))._unsafeUnwrap();
        const smallSample = result.matches.find((m) => m.rule.id === "INFLEXA-R-000101");
        expect(smallSample?.applicability).toBe("applies");
        expect(smallSample?.rule.effect.severity).toBe("reject");
        expect(smallSample?.rule.evidence.sources.some((s) => s.doi !== undefined || s.pmid !== undefined)).toBe(true);
    });
});

describe("withKnowledgeObservation", () => {
    test("a consultation reports one event with the corpus and the ids", async () => {
        const dir = await writeCorpus([RULE("INFLEXA-R-000001", "note")]);
        const kb = (await loadFileKnowledgeBase({ dir }))._unsafeUnwrap();
        const events: KnowledgeConsultation[] = [];
        const observed = withKnowledgeObservation(kb, { observe: (e) => events.push(e) });

        (await observed.findRules({}, session))._unsafeUnwrap();
        (await observed.getRule("INFLEXA-R-000001", session))._unsafeUnwrap();

        expect(events).toHaveLength(2);
        expect(events[0]).toEqual({
            kind: "find_rules",
            corpus: { corpusId: "test-corpus", version: "0.9.0" },
            ruleIds: ["INFLEXA-R-000001"],
            agentId: "conversation-agent",
        });
        expect(events[1]?.kind).toBe("get_rule");
    });

    test("a throwing callback never fails the consultation", async () => {
        const kb = createNoopKnowledgeBase();
        const observed = withKnowledgeObservation(kb, {
            observe: () => {
                throw new Error("observer fault");
            },
        });
        const result = (await observed.findRules({}, session))._unsafeUnwrap();
        expect(result.matches).toEqual([]);
    });
});
