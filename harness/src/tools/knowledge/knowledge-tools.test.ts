import { describe, expect, test } from "bun:test";
import { okAsync } from "neverthrow";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import type { KnowledgeBase, RuleMatch } from "../../knowledge/knowledge-base.js";
import { RuleRecordSchema, type RuleRecord } from "../../knowledge/rule-record.js";
import { createKnowledgeTools } from "./knowledge-tools.js";

const CORPUS = { corpusId: "test-corpus", version: "0.9.0" };

const rule = (id: string, severity: "reject" | "warn" | "note"): RuleRecord =>
    RuleRecordSchema.parse({
        id,
        title: `Rule ${id}`,
        applies: {},
        effect: { severity, statement: `Statement of ${id}.` },
        evidence: { sources: [{ citation: "A citation", doi: "10.1000/x" }] },
        version: "1.0.0",
    });

/** An in-memory `KnowledgeBase` over fixed matches — no files, no corpus dir. */
function fixtureKb(matches: RuleMatch[]): KnowledgeBase {
    const byId = new Map(matches.map((m) => [m.rule.id, m.rule]));
    return {
        findRules: () => okAsync({ corpus: CORPUS, matches }),
        getRule: (id) => {
            const found = byId.get(id);
            return okAsync(found === undefined ? { found: false as const, id } : { found: true as const, corpus: CORPUS, rule: found });
        },
        describeCorpus: () => CORPUS,
    };
}

describe("knowledge_search", () => {
    test("matches carry id, severity, applicability, and statement, and the recorder sees the ids", async () => {
        const recorded: string[] = [];
        const kb = fixtureKb([
            { rule: rule("INFLEXA-R-000001", "reject"), applicability: "applies" },
            { rule: rule("INFLEXA-R-000002", "warn"), applicability: "not_evaluable" },
        ]);
        const [search] = createKnowledgeTools({ knowledge: kb, onRuleIds: (ids) => recorded.push(...ids) });
        const { ctx } = makeToolContext();

        const result = (await search!.execute({ omicsType: "transcriptomics" }, ctx))._unsafeUnwrap() as {
            status: string;
            corpus: object;
            matches: { id: string; severity: string; applicability: string }[];
        };
        expect(result.status).toBe("ok");
        expect(result.corpus).toEqual(CORPUS);
        expect(result.matches.map((m) => m.id)).toEqual(["INFLEXA-R-000001", "INFLEXA-R-000002"]);
        expect(result.matches[0]?.severity).toBe("reject");
        expect(recorded).toEqual(["INFLEXA-R-000001", "INFLEXA-R-000002"]);
    });

    test("an absent source is a data outcome", async () => {
        const [search] = createKnowledgeTools({});
        const { ctx } = makeToolContext();
        const result = (await search!.execute({ query: "anything" }, ctx))._unsafeUnwrap();
        expect(result).toEqual({ status: "no_knowledge_source" });
    });

    test("no matches is a data outcome with the corpus identity", async () => {
        const [search] = createKnowledgeTools({ knowledge: fixtureKb([]) });
        const { ctx } = makeToolContext();
        const result = (await search!.execute({ query: "nothing" }, ctx))._unsafeUnwrap();
        expect(result).toEqual({ status: "no_matches", corpus: CORPUS });
    });
});

describe("knowledge_read", () => {
    test("a full rule returns with its sources, and the recorder sees the id", async () => {
        const recorded: string[] = [];
        const kb = fixtureKb([{ rule: rule("INFLEXA-R-000001", "warn"), applicability: "applies" }]);
        const [, read] = createKnowledgeTools({ knowledge: kb, onRuleIds: (ids) => recorded.push(...ids) });
        const { ctx } = makeToolContext();

        const result = (await read!.execute({ id: "INFLEXA-R-000001" }, ctx))._unsafeUnwrap() as { status: string; rule: RuleRecord };
        expect(result.status).toBe("ok");
        expect(result.rule.evidence.sources[0]?.doi).toBe("10.1000/x");
        expect(recorded).toEqual(["INFLEXA-R-000001"]);
    });

    test("an unknown id is a data variant, and nothing records", async () => {
        const recorded: string[] = [];
        const [, read] = createKnowledgeTools({ knowledge: fixtureKb([]), onRuleIds: (ids) => recorded.push(...ids) });
        const { ctx } = makeToolContext();
        const result = (await read!.execute({ id: "INFLEXA-R-999999" }, ctx))._unsafeUnwrap();
        expect(result).toEqual({ status: "not_found", id: "INFLEXA-R-999999" });
        expect(recorded).toEqual([]);
    });

    test("an absent source is a data outcome", async () => {
        const [, read] = createKnowledgeTools({});
        const { ctx } = makeToolContext();
        const result = (await read!.execute({ id: "INFLEXA-R-000001" }, ctx))._unsafeUnwrap();
        expect(result).toEqual({ status: "no_knowledge_source" });
    });
});
