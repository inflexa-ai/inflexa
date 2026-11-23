import { describe, expect, test } from "bun:test";

import { workloadIdentityOf } from "../workload-identity.js";

const USER = { uid: 1234, gid: 1234, groups: [1234, 3000] };

describe("workloadIdentityOf — one rule from the engine", () => {
    test("no executor fact keeps the image user and opens nothing", () => {
        expect(workloadIdentityOf(undefined)).toEqual({ env: {}, securityOpt: [] });
    });

    test("a VM engine that masks the owner keeps the image user and opens nothing", () => {
        expect(workloadIdentityOf({ kind: "vm", bindOwnership: "masked" })).toEqual({ env: {}, securityOpt: [] });
    });

    test("a VM engine that shows the host owner keeps the image user and opens the step tree", () => {
        expect(workloadIdentityOf({ kind: "vm", bindOwnership: "host-preserved" })).toEqual({ env: {}, securityOpt: [], stepTreeAccess: "world-writable" });
    });

    test("a rootful engine drops to the host user with its groups, and the step tree stays as the host made it", () => {
        expect(workloadIdentityOf({ kind: "rootful", user: USER, selinux: false })).toEqual({
            env: { SANDBOX_UID: "1234", SANDBOX_GID: "1234", SANDBOX_GROUPS: "1234,3000" },
            securityOpt: [],
        });
    });

    test("a rootful engine with SELinux turns the label separation off", () => {
        expect(workloadIdentityOf({ kind: "rootful", user: USER, selinux: true }).securityOpt).toEqual(["label=disable"]);
    });

    test("a host user with no supplementary group gives an empty group list", () => {
        expect(workloadIdentityOf({ kind: "rootful", user: { uid: 1234, gid: 1234, groups: [] }, selinux: false }).env.SANDBOX_GROUPS).toBe("");
    });

    test("a host uid 0 stays the image user, and the step tree opens to it", () => {
        expect(workloadIdentityOf({ kind: "rootful", user: { uid: 0, gid: 0, groups: [0] }, selinux: true })).toEqual({
            env: {},
            securityOpt: ["label=disable"],
            stepTreeAccess: "world-writable",
        });
    });

    test("rootless Podman maps the user onto the image user and keeps the groups", () => {
        expect(workloadIdentityOf({ kind: "rootless-podman", selinux: true })).toEqual({
            env: { SANDBOX_KEEP_GROUPS: "1" },
            securityOpt: ["label=disable"],
            usernsMode: "keep-id:uid=1000,gid=1000",
            annotations: { "run.oci.keep_original_groups": "1" },
        });
    });
});
