import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { makeSession } from "../providers/__fixtures__/session.js";
import { createNoopKnowledgeBase } from "../knowledge/noop-knowledge-base.js";
import type { KnowledgeConsultation } from "../knowledge/observe.js";
import { resolveCompositionKnowledge } from "./assemble.js";

const session = makeSession();

async function writeCorpusDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "resolve-knowledge-"));
    await mkdir(join(dir, "rules"), { recursive: true });
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ corpusId: "dir-corpus", version: "0.1.0", ruleFiles: ["rules/all.json"] }));
    await writeFile(
        join(dir, "rules", "all.json"),
        JSON.stringify([
            {
                id: "INFLEXA-R-000001",
                title: "A rule",
                applies: {},
                effect: { severity: "note", statement: "A statement." },
                evidence: { sources: [{ citation: "A citation", doi: "10.1000/x" }] },
                version: "1.0.0",
            },
        ]),
    );
    return dir;
}

describe("resolveCompositionKnowledge", () => {
    test("a bound seam wins over a configured directory", async () => {
        const seam = createNoopKnowledgeBase();
        const dir = await writeCorpusDir();
        const resolved = await resolveCompositionKnowledge({ knowledge: seam, knowledgeDir: dir });
        expect(resolved?.describeCorpus()).toEqual({ corpusId: "noop", version: "0.0.0" });
    });

    test("a directory alone gives the file-backed realization", async () => {
        const dir = await writeCorpusDir();
        const resolved = await resolveCompositionKnowledge({ knowledgeDir: dir });
        expect(resolved?.describeCorpus()).toEqual({ corpusId: "dir-corpus", version: "0.1.0" });
    });

    test("neither input gives an absent source", async () => {
        const resolved = await resolveCompositionKnowledge({});
        expect(resolved).toBeUndefined();
    });

    test("a directory with no manifest degrades to absent", async () => {
        const dir = await mkdtemp(join(tmpdir(), "resolve-knowledge-empty-"));
        const resolved = await resolveCompositionKnowledge({ knowledgeDir: dir });
        expect(resolved).toBeUndefined();
    });

    test("the observation wrapper applies to whichever arm resolved", async () => {
        const dir = await writeCorpusDir();
        const events: KnowledgeConsultation[] = [];
        const resolved = await resolveCompositionKnowledge({ knowledgeDir: dir, observeKnowledge: (e) => events.push(e) });
        (await resolved!.findRules({}, session))._unsafeUnwrap();
        expect(events).toHaveLength(1);
        expect(events[0]?.corpus).toEqual({ corpusId: "dir-corpus", version: "0.1.0" });
        expect(events[0]?.ruleIds).toEqual(["INFLEXA-R-000001"]);
    });
});
