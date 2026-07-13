import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { JSX } from "solid-js";

import { commands } from "./commands.tsx";
import { useKeymapRoot } from "./keymap.ts";
import { resetHotState, send, type SendSeams } from "./hooks/conversation.ts";
import type { Workspace } from "./contexts/workspace.ts";
import type { HarnessRuntime } from "../modules/harness/runtime.ts";

const stubRuntime = {
    pool: {},
    conversation: { provider: { capabilities: { toolCalling: true } } },
    conversationAgent: {},
    // The fake turn driver below never reaches the remaining runtime fields.
} as unknown as HarnessRuntime;

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
            openDialog: (render) => opened.push(render),
            closeDialog: () => closeCount++,
            openSession: () => {},
            quit: async () => {},
        };
        const command = commands.find((candidate) => candidate.id === "plan.explore-steps");
        expect(command).toBeDefined();
        if (!command) return;
        expect(command.enabled?.(workspace)).toBe(false);

        const seams: SendSeams = {
            runtime: () => stubRuntime,
            runChatTurn: async ({ emit }) => {
                void emit({
                    type: "data-plan",
                    source: { agentId: "tui-chat", callPath: ["tui-chat"] },
                    data: {
                        planId: "plan-1",
                        title: "Branching plan",
                        steps: [
                            {
                                id: "T1S1",
                                name: "Load inputs",
                                agent: "scientific-executor",
                                question: "Which inputs are valid?",
                                acceptance_criteria: ["Inputs validated"],
                                depends_on: [],
                            },
                        ],
                    },
                });
                return { kind: "ok", fallbackText: "" };
            },
        };
        await send({ sessionId: "session-1", analysisId: "analysis-1", userText: "show plan" }, seams);
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
