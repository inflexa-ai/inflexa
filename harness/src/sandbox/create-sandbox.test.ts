/**
 * Unit tests for the client's awaitExec option assembly: the liveness probe
 * self-wires from the backend ops, explicit seam injections win, and the
 * transport is client-owned. Pure composition — no DBOS, no backend.
 */

import { describe, expect, test } from "bun:test";
import type { AwaitExecOptions } from "./await-exec.js";
import { composeAwaitOptions } from "./create-sandbox.js";
import type { SandboxLiveness } from "./types.js";

const opsProbe = async (): Promise<SandboxLiveness> => ({ alive: false, oomKilled: false });
const injectedProbe = async (): Promise<SandboxLiveness> => ({ alive: true, oomKilled: false });

describe("composeAwaitOptions", () => {
    test("self-wires the backend probe when the caller injects none", () => {
        const options = composeAwaitOptions(undefined, "poll", opsProbe);
        expect(options.isAlive).toBe(opsProbe);
        expect(options.transport).toBe("poll");
    });

    test("an explicitly injected probe seam wins over the self-wired one", () => {
        const base: AwaitExecOptions = { isAlive: injectedProbe };
        const options = composeAwaitOptions(base, "poll", opsProbe);
        expect(options.isAlive).toBe(injectedProbe);
    });

    test("the transport is client-owned — a base transport cannot override it", () => {
        const base: AwaitExecOptions = { transport: "callback" };
        const options = composeAwaitOptions(base, "poll", opsProbe);
        expect(options.transport).toBe("poll");
    });

    test("other injected seams pass through untouched", () => {
        const sleep = async () => {};
        const options = composeAwaitOptions({ sleep }, "callback", opsProbe);
        expect(options.sleep).toBe(sleep);
        expect(options.transport).toBe("callback");
        expect(options.isAlive).toBe(opsProbe);
    });
});
