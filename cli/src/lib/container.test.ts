import { describe, expect, test } from "bun:test";
import { err, ok, type Result } from "neverthrow";

import {
    ContainerRuntimeError,
    firstReadyRuntime,
    resolveEngineSocket,
    runtimes,
    type CaptureResult,
    type ContainerRuntime,
    type EngineSocketProbes,
} from "./container.ts";

describe("runtime mountArg", () => {
    test("docker uses the bare host:container form", () => {
        expect(runtimes.docker.mountArg("/host/cfg", "/ctr/cfg")).toBe("/host/cfg:/ctr/cfg");
    });

    test("podman appends :z for the shared SELinux relabel", () => {
        expect(runtimes.podman.mountArg("/host/cfg", "/ctr/cfg")).toBe("/host/cfg:/ctr/cfg:z");
    });
});

describe("firstReadyRuntime", () => {
    function readyWhen(readyIds: readonly string[], probed?: string[]) {
        return (rt: ContainerRuntime): Promise<Result<void, ContainerRuntimeError>> => {
            probed?.push(rt.id);
            return Promise.resolve(readyIds.includes(rt.id) ? ok(undefined) : err(new ContainerRuntimeError(rt.notReadyHint)));
        };
    }

    test("returns the first ready candidate without probing the rest", async () => {
        const probed: string[] = [];
        const result = await firstReadyRuntime([runtimes.docker, runtimes.podman], readyWhen(["docker", "podman"], probed));
        expect(result._unsafeUnwrap().id).toBe("docker");
        expect(probed).toEqual(["docker"]);
    });

    test("falls through to a later ready candidate when the preferred one is not", async () => {
        const result = await firstReadyRuntime([runtimes.docker, runtimes.podman], readyWhen(["podman"]));
        expect(result._unsafeUnwrap().id).toBe("podman");
    });

    test("aggregates every candidate's guidance when none is ready", async () => {
        const result = await firstReadyRuntime([runtimes.docker, runtimes.podman], readyWhen([]));
        const error = result.match(
            () => null,
            (e) => e,
        );
        expect(error?.message).toContain("one of Docker, Podman");
        expect(error?.message).toContain(runtimes.docker.notReadyHint);
        expect(error?.message).toContain(runtimes.podman.notReadyHint);
    });
});

describe("resolveEngineSocket", () => {
    // A capture stub that returns a canned result and records the args it was asked
    // to spawn — so the "never spawns a real binary" contract is checkable in-band.
    function captureReturning(result: CaptureResult, spawned?: string[][]): EngineSocketProbes["capture"] {
        return (_rt, args) => {
            spawned?.push(args);
            return Promise.resolve(result);
        };
    }

    test("docker resolves to no socket and never spawns a probe", async () => {
        const spawned: string[][] = [];
        const result = await resolveEngineSocket(runtimes.docker, {
            platform: "linux",
            capture: captureReturning({ code: 0, stdout: "irrelevant", stderr: "" }, spawned),
            exists: () => true,
        });

        expect(result._unsafeUnwrap()).toBeUndefined();
        expect(spawned).toEqual([]);
    });

    test("podman on macOS returns the running machine's compat socket path", async () => {
        const spawned: string[][] = [];
        const result = await resolveEngineSocket(runtimes.podman, {
            platform: "darwin",
            capture: captureReturning({ code: 0, stdout: "/var/folders/xy/podman-machine-default-api.sock\n", stderr: "" }, spawned),
            // The darwin path trusts the machine's own report and never stats the socket.
            exists: () => false,
        });

        expect(result._unsafeUnwrap()).toBe("/var/folders/xy/podman-machine-default-api.sock");
        expect(spawned).toEqual([["machine", "inspect", "--format", "{{.ConnectionInfo.PodmanSocket.Path}}"]]);
    });

    test("podman on macOS with a stopped machine fails with a `podman machine start` hint", async () => {
        const result = await resolveEngineSocket(runtimes.podman, {
            platform: "darwin",
            capture: captureReturning({ code: 125, stdout: "", stderr: "VM does not exist" }),
            exists: () => true,
        });

        expect(result._unsafeUnwrapErr().message).toContain("podman machine start");
    });

    test("podman on macOS with an empty socket path fails actionably even on a zero exit", async () => {
        const result = await resolveEngineSocket(runtimes.podman, {
            platform: "darwin",
            capture: captureReturning({ code: 0, stdout: "   \n", stderr: "" }),
            exists: () => true,
        });

        expect(result._unsafeUnwrapErr().message).toContain("podman machine start");
    });

    test("podman on Linux returns the REST socket path when it exists on disk", async () => {
        const spawned: string[][] = [];
        const stated: string[] = [];
        const result = await resolveEngineSocket(runtimes.podman, {
            platform: "linux",
            capture: captureReturning({ code: 0, stdout: "/run/user/1000/podman/podman.sock\n", stderr: "" }, spawned),
            exists: (p) => {
                stated.push(p);
                return true;
            },
        });

        expect(result._unsafeUnwrap()).toBe("/run/user/1000/podman/podman.sock");
        expect(spawned).toEqual([["info", "--format", "{{.Host.RemoteSocket.Path}}"]]);
        // The existence gate stats exactly the reported path.
        expect(stated).toEqual(["/run/user/1000/podman/podman.sock"]);
    });

    test("podman on Linux fails with a `podman.socket` hint when the reported socket is absent on disk", async () => {
        const result = await resolveEngineSocket(runtimes.podman, {
            platform: "linux",
            capture: captureReturning({ code: 0, stdout: "/run/user/1000/podman/podman.sock\n", stderr: "" }),
            // A reachable CLI reported a path, but nothing is listening on it.
            exists: () => false,
        });

        expect(result._unsafeUnwrapErr().message).toContain("systemctl --user enable --now podman.socket");
    });

    test("podman on Linux fails when `podman info` exits non-zero", async () => {
        const result = await resolveEngineSocket(runtimes.podman, {
            platform: "linux",
            capture: captureReturning({ code: 1, stdout: "", stderr: "Cannot connect to Podman" }),
            exists: () => true,
        });

        expect(result._unsafeUnwrapErr().message).toContain("systemctl --user enable --now podman.socket");
    });
});
