/**
 * `submitExec` step tests — the `runStep` and `fetch` hooks are injected so
 * the test never touches DBOS or a real socket. `submitExec` wraps its POST in
 * a DBOS step keyed `sandbox.submit-exec.${execId}`, returns on a 202, and
 * throws on a non-202.
 */

import { describe, expect, test } from "bun:test";
import { verifyCallback } from "./hmac.js";
import { submitExec } from "./submit-exec.js";
import type { SandboxRef } from "./types.js";

const REF: SandboxRef = {
    sandboxId: "sbx-1",
    host: "127.0.0.1",
    port: 8765,
    backend: "docker",
    callbackSecret: "base64:dGVzdHNlY3JldA==",
};

function fetchResponding(
    responses: Array<{
        status: number;
        body: unknown;
    }>,
) {
    let i = 0;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fn: typeof fetch = (async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const r = responses[i++] ?? { status: 500, body: { error: "unexpected" } };
        return new Response(JSON.stringify(r.body), {
            status: r.status,
            headers: { "content-type": "application/json" },
        });
    }) as unknown as typeof fetch;
    return { fn, calls };
}

describe("submitExec", () => {
    test("happy path: POSTs once and returns on 202", async () => {
        const { fn, calls } = fetchResponding([{ status: 202, body: { execId: "wf-1:s-a:fn-0", status: "started" } }]);

        await submitExec(
            REF,
            { command: ["echo", "hi"], execId: "wf-1:s-a:fn-0" },
            {
                fetch: fn,
                runStep: (work, _config) => work(),
            },
        );

        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe("http://127.0.0.1:8765/exec");
        expect(calls[0]!.init?.method).toBe("POST");
        expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
            command: ["echo", "hi"],
            execId: "wf-1:s-a:fn-0",
        });
    });

    test("signs the exact bytes it POSTs, so sandbox-server's inbound check passes", async () => {
        const { fn, calls } = fetchResponding([{ status: 202, body: { execId: "wf-1:s-a:fn-0", status: "started" } }]);

        await submitExec(REF, { command: ["echo", "hi"], execId: "wf-1:s-a:fn-0" }, { fetch: fn, runStep: (w) => w() });

        const headers = calls[0]!.init!.headers as Record<string, string>;
        const raw = calls[0]!.init!.body as string;
        const timestamp = Number.parseInt(headers["x-sandbox-timestamp"]!, 10);
        // Verify the way sandbox-server does: recompute the HMAC over the exact
        // body bytes and confirm the header signature matches.
        const verdict = verifyCallback({
            execId: "wf-1:s-a:fn-0",
            body: raw,
            signature: headers["x-sandbox-signature"]!,
            timestamp,
            secret: REF.callbackSecret,
            nowSec: timestamp,
            freshnessSec: 300,
        });
        expect(verdict.valid).toBe(true);
    });

    test("dedup hit: 202 with existing-state body is also success", async () => {
        const { fn, calls } = fetchResponding([
            {
                status: 202,
                body: { execId: "wf-1:s-a:fn-0", status: "started", dedup_hit: true },
            },
        ]);

        await expect(submitExec(REF, { command: ["echo", "hi"], execId: "wf-1:s-a:fn-0" }, { fetch: fn, runStep: (w) => w() })).resolves.toBeUndefined();
        expect(calls).toHaveLength(1);
    });

    test("non-202 status throws", async () => {
        const { fn } = fetchResponding([{ status: 500, body: { error: "boom" } }]);
        await expect(submitExec(REF, { command: ["echo", "hi"], execId: "wf-1:s-a:fn-0" }, { fetch: fn, runStep: (w) => w() })).rejects.toThrow(/500/);
    });

    test("503 status throws", async () => {
        const { fn } = fetchResponding([{ status: 503, body: { error: "unavailable" } }]);
        await expect(submitExec(REF, { command: ["echo", "hi"], execId: "wf-1:s-a:fn-0" }, { fetch: fn, runStep: (w) => w() })).rejects.toThrow(/503/);
    });

    test("replay-safety: when runStep returns cached output, fetch is not called", async () => {
        // Stub runStep to mimic a replay — it never invokes the work fn.
        let workCalls = 0;
        let fetchCalls = 0;
        const fn: typeof fetch = (async () => {
            fetchCalls++;
            return new Response("{}", { status: 202 });
        }) as unknown as typeof fetch;

        const cachedRunStep = async <T>(_work: () => Promise<T>, _c: { name: string }) => {
            workCalls++;
            return undefined as unknown as T;
        };

        await submitExec(REF, { command: ["echo", "hi"], execId: "wf-1:s-a:fn-0" }, { fetch: fn, runStep: cachedRunStep });

        expect(workCalls).toBe(1);
        expect(fetchCalls).toBe(0);
    });

    test("step name carries the execId so each submit is a distinct cache key", async () => {
        const names: string[] = [];
        await submitExec(
            REF,
            { command: ["echo"], execId: "wf-7:s-z:fn-3" },
            {
                fetch: (async () => new Response("{}", { status: 202 })) as unknown as typeof fetch,
                runStep: async (work, config) => {
                    names.push(config.name);
                    return work();
                },
            },
        );
        expect(names).toEqual(["sandbox.submit-exec.wf-7:s-z:fn-3"]);
    });
});
