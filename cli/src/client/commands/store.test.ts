import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";

import type { FarmLinkView } from "../../api/store.ts";
import type { ClientOpts } from "../api.ts";
import { storeLink } from "./store.ts";

/** Run `fn` with the console captured, and restore the exit code, which a refusal sets. */
async function captured(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string; exitCode: typeof process.exitCode }> {
    const origLog = console.log;
    const origError = console.error;
    const origExitCode = process.exitCode;
    let stdout = "";
    let stderr = "";
    console.log = (msg?: unknown) => {
        stdout += `${String(msg)}\n`;
    };
    console.error = (msg?: unknown) => {
        stderr += `${String(msg)}\n`;
    };
    try {
        await fn();
        return { stdout, stderr, exitCode: process.exitCode };
    } finally {
        console.log = origLog;
        console.error = origError;
        // Bun ignores an `undefined` assignment, thus a captured failure code clears with an explicit 0.
        process.exitCode = origExitCode ?? 0;
    }
}

describe("store link", () => {
    test("links through the farm route of the analysis, and prints each link", async () => {
        const sent: { url: string; body: unknown }[] = [];
        const linked: FarmLinkView = { linked: ["igraph==0.11.8"], storeDirs: 3 };
        const opts: ClientOpts = {
            discover: () => ok({ baseUrl: "http://store.test", token: "t" }),
            fetch: async (url, init) => {
                sent.push({ url, body: JSON.parse(String(init.body)) });
                return new Response(JSON.stringify(linked), { status: 200, headers: { "Content-Type": "application/json" } });
            },
        };
        const run = await captured(() => storeLink({ id: "ana-1", name: "Tumor atlas" }, ["igraph"], "python", opts));
        expect(sent).toEqual([{ url: "http://store.test/api/v1/analyses/ana-1/farm/link", body: { packages: ["igraph"], lang: "python" } }]);
        expect(run.stdout).toContain('Linked igraph==0.11.8 into the farm of "Tumor atlas".\nThat farm links 3 store directories now.');
        expect(run.exitCode ?? 0).toBe(0);
    });
});
