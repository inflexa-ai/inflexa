import { afterEach, describe, expect, test } from "bun:test";
import { err, errAsync, ok, okAsync, type ResultAsync } from "neverthrow";
import { createRoot } from "solid-js";

import type { AgentList, AgentSelection } from "../../api/machine.ts";
import type { ServerDiscovery, ServerState } from "../../api/server.ts";
import type { ClientError } from "../../client/api.ts";
import { describeServerError } from "../../client/server.ts";
import {
    bootState,
    agentModels,
    checkServer,
    recoverServerBoot,
    refreshAgentModels,
    watchServerBoot,
    watchAgentModels,
    __resetBootForTest,
    __setBootStateForTest,
    type BootRecoveryOpts,
    type ServerCheckOpts,
} from "./boot.ts";
import { setChatStatus } from "./status.ts";
import { watchBootRecovery } from "../app.tsx";
import { dialogClear, dialogIsOpen, dialogPush } from "../components/dialog/dialog_host.tsx";

afterEach(() => __resetBootForTest());

const identity = { version: "0.0.0-test", apiVersion: 1, startedAt: "2026-10-02T00:00:00.000Z" } as const;
const starting: ServerState = { ...identity, phase: "starting" };
const ready = (model: string): ServerState => ({ ...identity, phase: "ready", connection: { provider: "anthropic", mode: "cliproxy", model } });

/** The discovery file of the server that the scripted reads answer for. */
const DISCOVERY: ServerDiscovery = {
    pid: 4242,
    port: 8436,
    token: "t".repeat(64),
    version: "0.0.0-test",
    apiVersion: 1,
    startedAt: "2026-10-02T00:00:00.000Z",
    channel: "development",
};

/** Watch opts that answer each read with the next of `answers` (the last one repeats), and count the reads and the sleeps. */
function scripted(answers: (() => ResultAsync<ServerState, ClientError>)[]): { opts: ServerCheckOpts; reads: () => number; sleeps: () => number } {
    let reads = 0;
    let sleeps = 0;
    return {
        opts: {
            readState: () => answers[Math.min(reads++, answers.length - 1)]!(),
            sleep: async () => {
                sleeps += 1;
            },
            pollMs: 1,
            readDiscovery: () => DISCOVERY,
        },
        reads: () => reads,
        sleeps: () => sleeps,
    };
}

describe("boot store transitions", () => {
    test("starts idle", () => {
        expect(bootState().phase).toBe("idle");
    });

    test("booting is published synchronously, then a ready server settles the store with its model and connection", async () => {
        const pending = watchServerBoot(scripted([() => okAsync(ready("claude-test"))]).opts);
        // watchServerBoot sets `booting` before its first await, so the transition is observable without
        // awaiting the read — this is what the status bar / animation mount on.
        expect(bootState().phase).toBe("booting");

        await pending;
        expect(bootState()).toEqual({ phase: "ready", model: "claude-test", connection: { provider: "anthropic", mode: "cliproxy" } });
    });

    test("a starting server is read again after each sleep, until it is ready", async () => {
        const script = scripted([() => okAsync(starting), () => okAsync(starting), () => okAsync(ready("claude-late"))]);
        await watchServerBoot(script.opts);
        expect(script.reads()).toBe(3);
        expect(script.sleeps()).toBe(2);
        expect(bootState().phase).toBe("ready");
    });

    test("a failed boot of the server publishes its actionable message", async () => {
        const failed: ServerState = {
            ...identity,
            phase: "failed",
            bootError: { reason: "runtime_already_active", message: "pid 4821 holds it", detailLines: [] },
        };
        await watchServerBoot(scripted([() => okAsync(failed)]).opts);
        expect(bootState()).toEqual({ phase: "failed", message: "pid 4821 holds it", recovery: "boot_again" });
    });

    test("a boot that failed for the provider login offers the sign-in, not a bare new boot", async () => {
        const failed: ServerState = {
            ...identity,
            phase: "failed",
            bootError: { reason: "sign_in_required", message: "no provider login", detailLines: [] },
        };
        await watchServerBoot(scripted([() => okAsync(failed)]).opts);
        expect(bootState()).toEqual({ phase: "failed", message: "no provider login", recovery: "sign_in" });
    });

    test("no server that answers settles the store as failed, and offers to start one", async () => {
        const unreachable: ClientError = {
            type: "unreachable",
            reason: "connection_failed",
            baseUrl: "http://127.0.0.1:8436",
            cause: new Error("ECONNREFUSED"),
        };
        await watchServerBoot(scripted([() => errAsync(unreachable)]).opts);
        const settled = bootState();
        expect(settled.phase).toBe("failed");
        if (settled.phase === "failed") expect(settled.message).toContain("`inflexa server status`");
        if (settled.phase === "failed") expect(settled.recovery).toBe("start_server");
    });

    test("a server that refuses the read is not offered a start: a start cannot change a refusal", async () => {
        const refused: ClientError = { type: "http", status: 401, body: { error: "unauthorized", message: "Send the token." } };
        await watchServerBoot(scripted([() => errAsync(refused)]).opts);
        const settled = bootState();
        expect(settled.phase).toBe("failed");
        if (settled.phase === "failed") expect(settled.recovery).toBeUndefined();
    });

    test("a second call while booting or ready is a no-op (it reads nothing)", async () => {
        const first = scripted([() => okAsync(starting), () => okAsync(ready("claude-first"))]);
        const pending = watchServerBoot(first.opts);
        const second = scripted([() => okAsync(ready("should-not-happen"))]);
        await watchServerBoot(second.opts);
        await pending;
        await watchServerBoot(second.opts);

        expect(second.reads()).toBe(0);
        const settled = bootState();
        if (settled.phase === "ready") expect(settled.model).toBe("claude-first");
    });
});

describe("the recovery of a failed boot", () => {
    const failed: ServerState = { ...identity, phase: "failed", bootError: { reason: "sign_in_required", message: "no provider login", detailLines: [] } };

    /** Recovery opts over `answers`, with a log of the sign-in, the boot request, the server start, and each read, in order. */
    function recovery(
        answers: (() => ResultAsync<ServerState, ClientError>)[],
        requestBoot?: BootRecoveryOpts["requestBoot"],
        startServer?: BootRecoveryOpts["startServer"],
    ) {
        const calls: string[] = [];
        const watch = scripted(answers);
        const opts: BootRecoveryOpts = {
            ...watch.opts,
            readState: () => {
                calls.push("read");
                return watch.opts.readState();
            },
            signIn: async () => void calls.push("sign-in"),
            requestBoot: () => {
                calls.push("boot");
                return requestBoot === undefined ? okAsync({ ...identity, phase: "starting" }) : requestBoot();
            },
            startServer: () => {
                calls.push("start");
                return startServer === undefined ? Promise.resolve(ok(undefined)) : startServer();
            },
        };
        return { opts, calls };
    }

    test("the sign-in runs, then the store reads the server again until it is ready", async () => {
        await watchServerBoot(scripted([() => okAsync(failed)]).opts);
        const { opts, calls } = recovery([() => okAsync(starting), () => okAsync(ready("claude-after"))]);
        await recoverServerBoot("sign_in", opts);
        // `inflexa up` sends the boot request itself, thus the store sends none.
        expect(calls).toEqual(["sign-in", "read", "read"]);
        expect(bootState().phase).toBe("ready");
    });

    test("a new boot is requested, then the store reads the server again until it settles", async () => {
        await watchServerBoot(scripted([() => okAsync(failed)]).opts);
        const { opts, calls } = recovery([() => okAsync(starting), () => okAsync(failed)]);
        await recoverServerBoot("boot_again", opts);
        expect(calls).toEqual(["boot", "read", "read"]);
        expect(bootState()).toEqual({ phase: "failed", message: "no provider login", recovery: "sign_in" });
    });

    test("a boot request that the server did not take settles as failed with nothing more to offer, and reads nothing", async () => {
        await watchServerBoot(scripted([() => okAsync(failed)]).opts);
        const refused: ClientError = { type: "unreachable", reason: "connection_failed", baseUrl: "http://127.0.0.1:8436", cause: null };
        const { opts, calls } = recovery([() => okAsync(ready("never"))], () => errAsync(refused));
        await recoverServerBoot("boot_again", opts);
        expect(calls).toEqual(["boot"]);
        const settled = bootState();
        expect(settled.phase).toBe("failed");
        if (settled.phase === "failed") expect(settled.recovery).toBeUndefined();
    });
});

describe("the start of a server from the chat", () => {
    const unreachable: ClientError = { type: "unreachable", reason: "connection_failed", baseUrl: "http://127.0.0.1:8436", cause: new Error("ECONNREFUSED") };

    /** Recovery opts over `answers`, with a log of the server start and each read, in order. */
    function startOpts(answers: (() => ResultAsync<ServerState, ClientError>)[], startServer: BootRecoveryOpts["startServer"]) {
        const calls: string[] = [];
        const watch = scripted(answers);
        const opts: BootRecoveryOpts = {
            ...watch.opts,
            readState: () => {
                calls.push("read");
                return watch.opts.readState();
            },
            signIn: async () => void calls.push("sign-in"),
            requestBoot: () => {
                calls.push("boot");
                return okAsync(starting);
            },
            startServer: () => {
                calls.push("start");
                return startServer();
            },
        };
        return { opts, calls };
    }

    test("the start runs the spawn path of an instance command, then the store reads the server until it is ready", async () => {
        await watchServerBoot(scripted([() => errAsync(unreachable)]).opts);
        const { opts, calls } = startOpts([() => okAsync(starting), () => okAsync(ready("claude-after"))], async () => ok(undefined));

        const pending = recoverServerBoot("start_server", opts);
        // The start can take seconds, and the header must not keep saying that no server runs.
        expect(bootState().phase).toBe("booting");
        await pending;

        expect(calls).toEqual(["start", "read", "read"]);
        expect(bootState().phase).toBe("ready");
    });

    test("a start that failed offers the start again, with its reason, and reads nothing", async () => {
        await watchServerBoot(scripted([() => errAsync(unreachable)]).opts);
        const reason = "Could not start the Inflexa server: `inflexa serve --detach` exited with code 1. See its log: /logs/server.log";
        const { opts, calls } = startOpts([() => okAsync(ready("never"))], async () => err(reason));

        await recoverServerBoot("start_server", opts);

        expect(calls).toEqual(["start"]);
        expect(bootState()).toEqual({ phase: "failed", message: reason, recovery: "start_server" });
    });
});

// The poll of the chat asks the server at each tick (`checkServer`). The server pushes nothing, thus a stop
// shows only through a probe that gets no answer.
describe("the probe of the server at each poll tick", () => {
    const unreachable: ClientError = { type: "unreachable", reason: "connection_failed", baseUrl: "http://127.0.0.1:8436", cause: new Error("ECONNREFUSED") };
    const later = { ...identity, startedAt: "2026-10-03T12:00:00.000Z" };
    const failedBoot: ServerState = {
        ...identity,
        phase: "failed",
        bootError: { reason: "runtime_already_active", message: "pid 4821 holds it", detailLines: [] },
    };

    /** Let the boot that a probe follows read the server to its end. */
    async function settle(): Promise<void> {
        for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    test("the server that the store saw ready still answers: the store stays ready", async () => {
        await watchServerBoot(scripted([() => okAsync(ready("m"))]).opts);

        expect(await checkServer(scripted([() => okAsync(ready("m"))]).opts)).toBe(true);
        expect(bootState().phase).toBe("ready");
    });

    test("a server that stopped turns the store from ready to failed, and the recovery is the start of a server", async () => {
        await watchServerBoot(scripted([() => okAsync(ready("m"))]).opts);

        expect(await checkServer(scripted([() => errAsync(unreachable)]).opts)).toBe(false);

        const settled = bootState();
        expect(settled.phase).toBe("failed");
        if (settled.phase === "failed") expect(settled.recovery).toBe("start_server");
        if (settled.phase === "failed") expect(settled.message).toContain("`inflexa server status`");
    });

    test("the next probe that gets no answer leaves the store as it is, thus the dialog opens one time", async () => {
        await watchServerBoot(scripted([() => okAsync(ready("m"))]).opts);
        await checkServer(scripted([() => errAsync(unreachable)]).opts);
        const stopped = bootState();

        await checkServer(scripted([() => errAsync(unreachable)]).opts);

        expect(bootState()).toBe(stopped);
    });

    test("a server that answers again after the stop brings the store back to ready", async () => {
        await watchServerBoot(scripted([() => okAsync(ready("m"))]).opts);
        await checkServer(scripted([() => errAsync(unreachable)]).opts);

        const back = scripted([
            () => okAsync({ ...later, phase: "starting" }),
            () => okAsync({ ...later, phase: "ready", connection: { provider: "anthropic", mode: "cliproxy", model: "m2" } }),
        ]);
        expect(await checkServer(back.opts)).toBe(false);
        expect(bootState().phase).toBe("booting");
        await settle();

        expect(bootState()).toEqual({ phase: "ready", model: "m2", connection: { provider: "anthropic", mode: "cliproxy" } });
    });

    test("a different server between two probes is followed through its boot", async () => {
        await watchServerBoot(scripted([() => okAsync(ready("m"))]).opts);

        const restarted = scripted([
            () => okAsync({ ...later, phase: "starting" }),
            () => okAsync({ ...later, phase: "ready", connection: { provider: "anthropic", mode: "cliproxy", model: "m2" } }),
        ]);
        expect(await checkServer(restarted.opts)).toBe(false);
        expect(bootState().phase).toBe("booting");
        await settle();

        expect(bootState().phase).toBe("ready");
        expect(
            await checkServer(
                scripted([() => okAsync({ ...later, phase: "ready", connection: { provider: "anthropic", mode: "cliproxy", model: "m2" } })]).opts,
            ),
        ).toBe(true);
    });

    test("a new server of a different API version is not followed, and the store says what `ensureServer` says", async () => {
        await watchServerBoot(scripted([() => okAsync(ready("m"))]).opts);
        const newer: ServerState = {
            ...later,
            version: "9.9.9",
            apiVersion: 2,
            phase: "ready",
            connection: { provider: "anthropic", mode: "cliproxy", model: "m2" },
        };

        const probe = scripted([() => okAsync(newer)]);
        expect(await checkServer(probe.opts)).toBe(false);
        await settle();

        expect(probe.reads()).toBe(1);
        expect(bootState()).toEqual({ phase: "failed", message: describeServerError({ type: "api_mismatch", discovery: DISCOVERY, state: newer }) });

        // The next tick finds the same server: the store stays as it is, and still follows nothing.
        const mismatch = bootState();
        await checkServer(scripted([() => okAsync(newer)]).opts);
        await settle();
        expect(bootState()).toBe(mismatch);
    });

    test("a boot that failed and still fails is left as it is, thus its dialog does not open again at each tick", async () => {
        await watchServerBoot(scripted([() => okAsync(failedBoot)]).opts);
        const failed = bootState();

        expect(await checkServer(scripted([() => okAsync(failedBoot)]).opts)).toBe(false);

        expect(bootState()).toBe(failed);
    });
});

// The chat offers the recovery of each failed boot in a dialog. A boot can reach ready by a different path
// while the dialog waits for its answer: a different client starts the server, and the poll follows it.
describe("the dialog that offers the recovery of a failed boot", () => {
    let dispose: (() => void) | null = null;
    afterEach(() => {
        dispose?.();
        dispose = null;
        dialogClear();
    });

    function mount(): void {
        createRoot((d) => {
            dispose = d;
            watchBootRecovery(() => () => null);
        });
    }

    test("it opens at a failed boot, and closes when the boot reaches ready by a different path", () => {
        mount();
        __setBootStateForTest({ phase: "failed", message: "No Inflexa server answers.", recovery: "start_server" });
        expect(dialogIsOpen()).toBe(true);

        __setBootStateForTest({ phase: "booting" });
        expect(dialogIsOpen()).toBe(true);
        __setBootStateForTest({ phase: "ready", model: "m", connection: { provider: "anthropic", mode: "cliproxy" } });

        expect(dialogIsOpen()).toBe(false);
    });

    test("a dialog that the person opened over it stays open", () => {
        mount();
        __setBootStateForTest({ phase: "failed", message: "No Inflexa server answers.", recovery: "start_server" });
        dialogPush(() => null);

        __setBootStateForTest({ phase: "ready", model: "m", connection: { provider: "anthropic", mode: "cliproxy" } });

        expect(dialogIsOpen()).toBe(true);
    });
});

// The agent-models store mirrors `GET /api/v1/agents` of the server. These drive the store over a fake read
// and assert the reactive cell tracks it: seeded at the ready edge, and read again where the chat stops being
// busy, because a switch that waits for idle lands when the agent work settles.
describe("agent-models store (watchAgentModels)", () => {
    afterEach(() => setChatStatus("idle"));

    const opus: AgentSelection = { model: "claude-opus-4-8", effort: "high" };
    const sonnet: AgentSelection = { model: "claude-sonnet-4-5", effort: "medium" };

    /** An agent list with each role on `selection`, and `pending` on the conversation agent. */
    function agents(current: AgentSelection | null, pending: AgentSelection | null = null): AgentList {
        return {
            agents: [
                { role: "conversation", current, pending },
                { role: "sandbox", current: current === null ? null : sonnet, pending: null },
                { role: "utility", current: current === null ? null : sonnet, pending: null },
            ],
        };
    }

    /** A read that answers with the next of `answers` (the last one repeats), and counts the reads. */
    function scriptedAgents(answers: AgentList[]): { read: () => ResultAsync<AgentList, ClientError>; reads: () => number } {
        let reads = 0;
        return { read: () => okAsync(answers[Math.min(reads++, answers.length - 1)]!), reads: () => reads };
    }

    test("stays empty before ready, then seeds each agent's current model at the ready edge", async () => {
        const script = scriptedAgents([agents(opus)]);
        let dispose!: () => void;
        createRoot((d) => {
            dispose = d;
            watchAgentModels(script.read);
        });
        try {
            expect(agentModels().current).toEqual({ conversation: "", sandbox: "", utility: "" });
            expect(agentModels().efforts).toBeNull();
            expect(script.reads()).toBe(0);
            await watchServerBoot(scripted([() => okAsync(ready("claude-opus-4-8"))]).opts);
            await Promise.sleep(0);
            expect(agentModels().current).toEqual({ conversation: "claude-opus-4-8", sandbox: "claude-sonnet-4-5", utility: "claude-sonnet-4-5" });
            expect(agentModels().efforts).toEqual({ conversation: "high", sandbox: "medium", utility: "medium" });
        } finally {
            dispose();
        }
    });

    test("a switch scheduled behind work shows as pending, and the edge where the chat stops being busy reads it landed", async () => {
        const script = scriptedAgents([agents(opus, sonnet), agents(sonnet)]);
        let dispose!: () => void;
        createRoot((d) => {
            dispose = d;
            watchAgentModels(script.read);
        });
        try {
            await watchServerBoot(scripted([() => okAsync(ready("claude-opus-4-8"))]).opts);
            await Promise.sleep(0);
            expect(agentModels().pending.get("conversation")).toEqual(sonnet);
            expect(agentModels().current.conversation).toBe("claude-opus-4-8");

            setChatStatus("busy");
            await Promise.sleep(0);
            expect(script.reads()).toBe(1);
            setChatStatus("idle");
            await Promise.sleep(0);

            expect(script.reads()).toBe(2);
            expect(agentModels().current.conversation).toBe("claude-sonnet-4-5");
            expect(agentModels().pending.size).toBe(0);
        } finally {
            dispose();
        }
    });

    test("an agent with no runtime selection keeps the efforts unknown", async () => {
        await refreshAgentModels(scriptedAgents([agents(null)]).read);
        expect(agentModels().efforts).toBeNull();
        expect(agentModels().current.conversation).toBe("");
    });

    test("a failed read keeps the store as it was", async () => {
        await refreshAgentModels(scriptedAgents([agents(opus)]).read);
        await refreshAgentModels(() => errAsync({ type: "unreachable", reason: "connection_failed", baseUrl: "http://127.0.0.1:1", cause: null }));
        expect(agentModels().current.conversation).toBe("claude-opus-4-8");
    });
});
