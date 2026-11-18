import { describe, expect, test } from "bun:test";

import type { FileReferencePart, PlanPart } from "../chat-parts.js";
import type { MessagePart } from "../message.js";
import { repeatedPlanIndexes, supersededFileReferences } from "../repeated-cards.js";

describe("repeatedPlanIndexes", () => {
    function plan(id: string, planId: string): PlanPart {
        return { type: "data-plan", id, planId };
    }

    test("a show_plan card of the plan that generate_plan showed in the same message repeats it", () => {
        const parts: MessagePart[] = [
            { type: "tool-call", toolCallId: "c1", toolName: "generate_plan", outcome: "ok" },
            plan("pres-a", "pln-0000000a"),
            { type: "tool-call", toolCallId: "c2", toolName: "show_plan", outcome: "ok" },
            plan("pres-a", "pln-0000000a"),
        ];

        expect([...repeatedPlanIndexes(parts)]).toEqual([3]);
    });

    test("the cards of different plans do not repeat", () => {
        expect(repeatedPlanIndexes([plan("pres-a", "pln-0000000a"), plan("pres-b", "pln-0000000b")]).size).toBe(0);
    });

    test("a part of a type that the registry does not hold is not a plan card", () => {
        const parts: MessagePart[] = [plan("pres-a", "pln-0000000a"), { type: "data-plan-v2", id: "pres-a" }];

        expect(repeatedPlanIndexes(parts).size).toBe(0);
    });
});

describe("supersededFileReferences", () => {
    function card(id: string, ...paths: string[]): FileReferencePart {
        return { type: "data-file-reference", id, files: paths.map((path) => ({ path })) };
    }

    test("a show_file card takes a derived file from the card of the script", () => {
        const parts: MessagePart[] = [
            { type: "tool-call", toolCallId: "c1", toolName: "run_script", outcome: "ok" },
            card("fr-a", "conversation-sessions/t1/brief.pdf", "conversation-sessions/t1/c1.js"),
            { type: "text", text: "The brief:" },
            { type: "tool-call", toolCallId: "c2", toolName: "show_file", outcome: "ok" },
            card("fr-b", "conversation-sessions/t1/brief.pdf"),
        ];

        expect([...supersededFileReferences(parts)]).toEqual([[1, card("fr-a", "conversation-sessions/t1/c1.js")]]);
    });

    test("a card with no file left maps to null", () => {
        expect([...supersededFileReferences([card("fr-a", "a.png"), card("fr-b", "b.png", "a.png")])]).toEqual([[0, null]]);
    });

    test("the cards of different files keep their files", () => {
        expect(supersededFileReferences([card("fr-a", "a.png"), card("fr-b", "b.png")]).size).toBe(0);
    });
});
