import { describe, expect, test } from "bun:test";

import type { CaptureResult, ContainerRuntime } from "../../lib/container.ts";
import { runtimes } from "../../lib/container.ts";

import { EYES_IMAGE, createEphemeralEyes, type EphemeralEyesDeps } from "./eyes.ts";

const SCOPE = { analysisId: "ana-1", workspaceRoot: "/Users/someone/work/study/.inflexa/analyses/x" };

type Invocation = { rt: ContainerRuntime; args: string[] };

/**
 * A realization over recorded container commands. `startCode` and `removeCode` drive the two verbs, and every
 * other edge resolves at once. Thus a case spends no real time and it spawns no binary.
 */
function harness(overrides: Partial<EphemeralEyesDeps> & { startCode?: number; removeCode?: number; startErr?: string } = {}) {
    const calls: Invocation[] = [];
    const { startCode = 0, removeCode = 0, startErr = "", ...deps } = overrides;
    const eyes = createEphemeralEyes({
        runtime: runtimes.podman,
        run: async (rt, args): Promise<CaptureResult> => {
            calls.push({ rt, args });
            if (args[0] === "run") return { code: startCode, stdout: "container-abc\n", stderr: startErr };
            return { code: removeCode, stdout: "", stderr: removeCode === 0 ? "" : "device busy" };
        },
        freePort: async () => 45678,
        ready: async () => true,
        wait: async () => {},
        ...deps,
    });
    const argsOf = (verb: string): string[] => calls.find((c) => c.args[0] === verb)?.args ?? [];
    return { eyes, calls, argsOf };
}

describe("createEphemeralEyes", () => {
    test("one acquire starts one container and gives its loopback endpoint", async () => {
        const t = harness();

        const lease = await t.eyes(SCOPE);

        // The endpoint is the published host port, and the browser is reachable from this host alone.
        expect(lease.browserUrl).toBe("http://127.0.0.1:45678");
        expect(t.calls).toHaveLength(1);
        const args = t.argsOf("run");
        expect(args).toContain("-d");
        expect(args).toContain(EYES_IMAGE);
        // Chrome composes a full-page capture bitmap in /dev/shm, and the runtime default is too small for a
        // tall report page. Without this argument the look fails with a protocol error.
        expect(args).toContain("--shm-size");
        expect(args[args.indexOf("--shm-size") + 1]).toBe("1g");
    });

    test("the mount repeats the workspace root on both sides", async () => {
        // The browser navigates a file:// URL of the host tree, thus a container path that differed from the
        // host path would resolve nothing. The argument comes from the runtime descriptor, thus podman keeps
        // its relabel suffix.
        const t = harness();

        await t.eyes(SCOPE);

        expect(t.argsOf("run")).toContain(runtimes.podman.mountArg(SCOPE.workspaceRoot, SCOPE.workspaceRoot));
    });

    test("the container carries its own deadline, and not the deadline of this process", async () => {
        // The seam demands that a lease which no release ends still ends. A process can die between the
        // acquire and the finally, thus the bound runs inside the container.
        const t = harness({ lifetimeSeconds: 42 });

        await t.eyes(SCOPE);

        const args = t.argsOf("run");
        expect(args).toContain("--entrypoint");
        expect(args[args.indexOf("--entrypoint") + 1]).toBe("/usr/bin/timeout");
        expect(args[args.indexOf(EYES_IMAGE) + 1]).toBe("42");
    });

    test("the publish binds loopback alone", async () => {
        // The browser reads the workspace of the user. A published port on every interface would serve that
        // tree to the network.
        const t = harness();

        await t.eyes(SCOPE);

        expect(t.argsOf("run")).toContain("127.0.0.1:45678:9222");
    });

    test("the release removes the container", async () => {
        const t = harness();

        await (await t.eyes(SCOPE)).release();

        expect(t.argsOf("rm")).toEqual(["rm", "-f", "container-abc"]);
    });

    test("a removal that fails still resolves the release", async () => {
        // The container carries its own deadline, thus a failed removal costs one idle browser and never a
        // leak. The look already gave its result, and the harness must not lose it to this.
        const t = harness({ removeCode: 1 });

        const lease = await t.eyes(SCOPE);

        await expect(lease.release()).resolves.toBeUndefined();
    });

    test("a container that does not start throws, and it removes nothing", async () => {
        const t = harness({ startCode: 125, startErr: "no such image" });

        await expect(t.eyes(SCOPE)).rejects.toThrow("no such image");
        // Nothing started, thus a removal would name a container that the runtime never made.
        expect(t.calls.filter((c) => c.args[0] === "rm")).toHaveLength(0);
    });

    test("a container that never answers throws, and the acquire removes it", async () => {
        // The started container holds a port and a slot. The failed acquire hands over no lease, thus nothing
        // else can end it.
        let clock = 0;
        const t = harness({ ready: async () => false, now: () => (clock += 10_000) });

        await expect(t.eyes(SCOPE)).rejects.toThrow("did not answer");
        expect(t.argsOf("rm")).toEqual(["rm", "-f", "container-abc"]);
    });

    test("the count bound holds a third look until a release", async () => {
        // The page gate of the harness bounds one endpoint, and each look here names a new endpoint. Thus
        // this realization is the only thing that caps how many browsers run at one time.
        const t = harness({ maxBrowsers: 2 });

        const first = await t.eyes(SCOPE);
        await t.eyes(SCOPE);
        let third = false;
        const pending = t.eyes(SCOPE).then((lease) => {
            third = true;
            return lease;
        });

        await Promise.resolve();
        expect(third).toBe(false);

        await first.release();
        await pending;
        expect(third).toBe(true);
    });

    test("a failed acquire gives its slot back", async () => {
        // A slot that a failure kept would starve the gate, and the eyes would stop answering after a run of
        // faults with nothing to say why.
        const t = harness({ maxBrowsers: 1, startCode: 1, startErr: "port in use" });

        await expect(t.eyes(SCOPE)).rejects.toThrow("port in use");
        await expect(t.eyes(SCOPE)).rejects.toThrow("port in use");
        expect(t.calls.filter((c) => c.args[0] === "run")).toHaveLength(2);
    });

    test("the docker descriptor gives the bare mount form", async () => {
        // The two runtimes diverge on the mount argument alone, and the descriptor owns that difference.
        const t = harness({ runtime: runtimes.docker });

        await t.eyes(SCOPE);

        expect(t.argsOf("run")).toContain(`${SCOPE.workspaceRoot}:${SCOPE.workspaceRoot}`);
    });
});
