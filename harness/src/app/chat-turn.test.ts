import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { createThreadStore } from "../memory/thread-store.js";
import { createThreadHistory } from "../memory/thread-history.js";
import { deriveThreadTitle } from "../memory/derive-thread-title.js";
import { prepareChatTurn } from "./chat-turn.js";

const ANALYSIS_A = "analysis-a";
const ANALYSIS_B = "analysis-b";

let pool: Pool;
let drop: () => Promise<void>;

beforeEach(async () => {
    ({ pool, drop } = await withSchema("chat-turn"));
});

afterEach(async () => {
    await drop();
});

/** Flatten a message's content to a searchable string. */
function contentText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map((b) => (typeof b === "object" && b && "text" in b ? String(b.text) : "")).join("\n");
    }
    return "";
}

describe("prepareChatTurn", () => {
    it("returns not_found when the thread is owned by a different analysis", async () => {
        const store = createThreadStore(pool);
        await store.createThread({
            threadId: "t1",
            analysisId: ANALYSIS_B,
            title: "Owned by B",
        });

        const result = await prepareChatTurn({ pool }, { analysisId: ANALYSIS_A, threadId: "t1", userInput: "hello" });

        expect(result.kind).toBe("not_found");
        // Ownership untouched — the foreign thread still belongs to B.
        const still = (await store.getThread("t1"))._unsafeUnwrap();
        expect(still!.analysisId).toBe(ANALYSIS_B);
    });

    it("creates the thread with a derived title and returns ok with history + new input", async () => {
        const store = createThreadStore(pool);
        const history = createThreadHistory(pool);

        // Seed one prior turn so it must appear in the assembled window.
        await history.appendTurn("t-new", [
            { role: "user", content: "earlier question about PCA" },
            { role: "assistant", content: "earlier answer" },
        ]);

        const result = await prepareChatTurn(
            { pool },
            {
                analysisId: ANALYSIS_A,
                threadId: "t-new",
                userInput: "run a differential expression analysis please",
            },
        );

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") throw new Error("unreachable");

        // Thread row created with a derived title.
        const created = (await store.getThread("t-new"))._unsafeUnwrap();
        expect(created).not.toBeNull();
        expect(created!.analysisId).toBe(ANALYSIS_A);
        expect(created!.title).toBe(deriveThreadTitle("run a differential expression analysis please"));

        // userMessage carries the new input.
        expect(contentText(result.userMessage.content)).toContain("run a differential expression analysis please");

        // messages include the prior turn's history AND the new user input.
        const joined = result.messages.map((m) => contentText(m.content)).join("\n");
        expect(joined).toContain("earlier question about PCA");
        expect(joined).toContain("earlier answer");
        expect(joined).toContain("run a differential expression analysis please");
    });

    it("leaves an existing non-empty title unchanged", async () => {
        const store = createThreadStore(pool);
        await store.createThread({
            threadId: "t-titled",
            analysisId: ANALYSIS_A,
            title: "My Existing Title",
        });

        const result = await prepareChatTurn(
            { pool },
            {
                analysisId: ANALYSIS_A,
                threadId: "t-titled",
                userInput: "a brand new message that would derive a different title",
            },
        );

        expect(result.kind).toBe("ok");
        const after = (await store.getThread("t-titled"))._unsafeUnwrap();
        expect(after!.title).toBe("My Existing Title");
    });
});
