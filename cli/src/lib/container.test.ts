import { describe, expect, test } from "bun:test";

import { runtimes } from "./container.ts";

describe("runtime mountArg", () => {
    test("docker uses the bare host:container form", () => {
        expect(runtimes.docker.mountArg("/host/cfg", "/ctr/cfg")).toBe("/host/cfg:/ctr/cfg");
    });

    test("podman appends :z for the shared SELinux relabel", () => {
        expect(runtimes.podman.mountArg("/host/cfg", "/ctr/cfg")).toBe("/host/cfg:/ctr/cfg:z");
    });
});
