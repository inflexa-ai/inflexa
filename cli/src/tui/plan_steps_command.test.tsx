import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ok, okAsync, type Result } from "neverthrow";
import { testRender } from "@opentui/solid";
import type { JSX } from "solid-js";
import type { ChatFrame } from "@inflexa-ai/harness/contracts/index.js";

import type { ClientError } from "../client/api.ts";
import { commands } from "./commands.tsx";
import { useKeymapRoot } from "./keymap.ts";
import { resetHotState, send, type SendOpts } from "./hooks/conversation.ts";
import type { Workspace } from "./contexts/workspace.ts";

const source = { agentId: "tui-chat", callPath: ["tui-chat"] };

/** The frames of one turn stream, as the client reads them off the server. */
async function* framesOf(frames: readonly ChatFrame[]): AsyncGenerator<Result<ChatFrame, ClientError>> {
    // eslint-disable-next-line neverthrow/must-use-result -- a yielded Result is consumed by the `for await` of `send`, which the rule cannot follow
    for (const frame of frames) yield ok(frame);
}

function unexpected(name: string): () => never {
    return () => {
        throw new Error(`the test did not expect a call of ${name}`);
    };
}

function KeymapHarness(props: { children: JSX.Element }): JSX.Element {
    useKeymapRoot();
    return (
        <box width="100%" height="100%">
            {props.children}
        </box>
    );
}

describe("plan.explore-steps", () => {
    beforeEach(() => resetHotState());
    afterEach(() => resetHotState());

    test("is hidden without a plan, then opens picker and selected-step detail", async () => {
        const opened: Array<() => JSX.Element> = [];
        let closeCount = 0;
        const workspace: Workspace = {
            analysis: null,
            sessionId: "session-1",
            workingDir: "/work",
            project: null,
            anchor: null,
            inputCount: null,
            openDialog: (render) => opened.push(render),
            closeDialog: () => closeCount++,
            openSession: () => {},
            refreshScope: () => {},
            quit: async () => {},
        };
        const command = commands.find((candidate) => candidate.id === "plan.explore-steps");
        expect(command).toBeDefined();
        if (!command) return;
        expect(command.enabled?.(workspace)).toBe(false);

        // The server streams the plan part of the turn, then its `finish` frame. A part frame is flat on
        // the wire: `{ type, ...data, source }`.
        const plan = {
            type: "data-plan",
            source,
            id: "plan-card-1",
            planId: "pln-00000001",
            title: "Branching plan",
            steps: [
                {
                    id: "T1S1",
                    name: "Load inputs",
                    agent: "scientific-executor",
                    question: "Which inputs are valid?",
                    acceptance_criteria: ["Inputs validated"],
                    depends_on: [],
                    maxSteps: 30,
                },
            ],
        } satisfies ChatFrame;
        const opts: SendOpts = {
            startTurn: () => okAsync({ turnId: "turn-1", frames: framesOf([plan, { type: "finish", source }]) }),
            abortTurn: unexpected("abortTurn"),
            fetchTurn: () =>
                okAsync({
                    turnId: "turn-1",
                    threadId: "session-1",
                    analysisId: "analysis-1",
                    status: "done",
                    startedAt: "2026-10-02T00:00:00.000Z",
                    opened: true,
                }),
            reloadTranscript: async () => undefined,
            healRetract: unexpected("healRetract"),
        };
        await send({ sessionId: "session-1", analysisId: "analysis-1", userText: "show plan" }, opts);
        expect(command.enabled?.(workspace)).toBe(true);

        await command.run(workspace);
        const picker = opened[0];
        expect(picker).toBeDefined();
        if (!picker) return;
        const pickerSetup = await testRender(() => <KeymapHarness>{picker()}</KeymapHarness>, { width: 100, height: 24 });
        try {
            await pickerSetup.renderOnce();
            await pickerSetup.renderOnce();
            expect(pickerSetup.captureCharFrame()).toContain("T1S1 Load inputs");
            pickerSetup.mockInput.pressEnter();
            await pickerSetup.renderOnce();
        } finally {
            pickerSetup.renderer.destroy();
        }

        expect(closeCount).toBe(1);
        const detail = opened[1];
        expect(detail).toBeDefined();
        if (!detail) return;
        const detailSetup = await testRender(detail, { width: 100, height: 24 });
        try {
            await detailSetup.renderOnce();
            const frame = detailSetup.captureCharFrame();
            expect(frame).toContain("Which inputs are valid?");
            expect(frame).toContain("Inputs validated");
        } finally {
            detailSetup.renderer.destroy();
        }
    });
});
