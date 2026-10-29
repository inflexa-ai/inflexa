/**
 * Test doubles of the sandbox module. `leaseOverClient` runs each exec of a bound lease on one machine of a fake
 * `SandboxClient`, thus a tool test keeps its fake client. `fakeLeases` records each binding and each release of a
 * workflow test, and gives each binding the same lease.
 */

import { err, ok } from "neverthrow";

import type { ResourceSpec } from "../../config/resource-limits.js";
import type { SandboxClient } from "../client.js";
import type { AcquireOutcome, BoundLease, LeaseBinding, SandboxLeases } from "../leases.js";
import type { ExecResult, SandboxRef, ToolchainSource } from "../types.js";

/** The deadline that a fake lease gives to the exec of its client: far in the future, as a real command timeout. */
const FAKE_DEADLINE_MS = 9_999_999_999_999;

export type FakeLease = BoundLease & {
    readonly acquired: ResourceSpec[];
    readonly released: { count: number };
};

export type LeaseOverClientOpts = {
    /** False: the lease starts with no grant, and an exec gives `no_lease` until `acquire`. Default true. */
    readonly held?: boolean;
    /** The outcome of `acquire`. Default: the requested size. */
    readonly grant?: (size: ResourceSpec) => AcquireOutcome;
};

/** A bound lease whose execs run on `ref` of `client`. */
export function leaseOverClient(client: Pick<SandboxClient, "exec">, ref: SandboxRef, opts: LeaseOverClientOpts = {}): FakeLease {
    let held = opts.held ?? true;
    const acquired: ResourceSpec[] = [];
    const released = { count: 0 };
    return {
        acquired,
        released,
        acquire: (size) => {
            acquired.push(size);
            const outcome = opts.grant?.(size) ?? { kind: "granted", size };
            if (outcome.kind === "granted") held = true;
            return Promise.resolve(outcome);
        },
        release: () => {
            released.count += 1;
            held = false;
            return Promise.resolve();
        },
        exec: async (request, emit) => {
            if (!held) return err({ kind: "no_lease" });
            return ok(await client.exec(ref, request, emit, FAKE_DEADLINE_MS));
        },
    };
}

/** A bound lease whose execs give `result`. */
export function leaseGiving(result: ExecResult, opts: LeaseOverClientOpts = {}): FakeLease {
    const ref: SandboxRef = { sandboxId: "sb-fake", host: "127.0.0.1", port: 8765, backend: "docker" };
    return leaseOverClient({ exec: () => Promise.resolve(result) }, ref, opts);
}

export type FakeLeases = SandboxLeases & {
    readonly bindings: LeaseBinding[];
    readonly releasedKeys: string[];
};

/** A sandbox module that gives `lease` to each binding, and records the bindings and the releases. */
export function fakeLeases(lease: BoundLease, toolchainSource: ToolchainSource = "store"): FakeLeases {
    const bindings: LeaseBinding[] = [];
    const releasedKeys: string[] = [];
    return {
        bindings,
        releasedKeys,
        toolchainSource,
        acquire: (_binding, size) => lease.acquire(size),
        release: (leaseKey) => {
            releasedKeys.push(leaseKey);
            return lease.release();
        },
        exec: (_leaseKey, request, emit) => lease.exec(request, emit),
        bind: (binding) => {
            bindings.push(binding);
            return {
                acquire: (size) => lease.acquire(size),
                release: () => {
                    releasedKeys.push(binding.leaseKey);
                    return lease.release();
                },
                exec: (request, emit) => lease.exec(request, emit),
            };
        },
    };
}
