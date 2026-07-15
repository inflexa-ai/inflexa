import { describe, expect, test } from "bun:test";
import { err, ok, type Result } from "neverthrow";

import { ContainerRuntimeError, firstReadyRuntime, runtimes, type ContainerRuntime } from "./container.ts";

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
