import { describe, expect, test } from "bun:test";
import { Show } from "solid-js";
import { testRender } from "@opentui/solid";
import type { BoxRenderable, TextareaRenderable } from "@opentui/core";

import { PausePrompt } from "./pause_prompt.tsx";
import { useKeymapRoot } from "../keymap.ts";
import { renderFrame } from "../../test_support/tui.ts";

// The frames show what the docked prompt says in each state, and the key tests drive the REAL keyboard bus through
// useKeymapRoot to prove the focus-target gate: bare r and s act only while the prompt holds focus, the same gate as
// the docked ask prompt. The colors are measured in theme_contrast.render.test.tsx.

function settleOf(setup: { renderOnce: () => Promise<void> }): () => Promise<void> {
    return async () => {
        await new Promise((r) => setTimeout(r, 35));
        await setup.renderOnce();
        await setup.renderOnce();
    };
}

function Harness(props: {
    withEditor?: boolean;
    busy?: boolean;
    onBox?: (r: BoxRenderable) => void;
    onTa?: (r: TextareaRenderable) => void;
    state?: "retrying" | "paused";
    onResume?: () => void;
    onHold?: () => void;
    onStop?: () => void;
}) {
    useKeymapRoot();
    return (
        <box width="100%" height="100%">
            <Show when={props.withEditor}>
                <textarea
                    ref={(r: TextareaRenderable) => {
                        queueMicrotask(() => r.focus());
                        props.onTa?.(r);
                    }}
                />
            </Show>
            <PausePrompt
                state={props.state ?? "paused"}
                cause="the host paused the work (payment_required)"
                othersWaiting={0}
                busy={props.busy}
                onResume={() => props.onResume?.()}
                onHold={() => props.onHold?.()}
                onStop={() => props.onStop?.()}
                onFocusReady={(r) => props.onBox?.(r)}
            />
        </box>
    );
}

describe("PausePrompt frames", () => {
    test("paused: the state, the cause with the reason of the host, the remedy, and resume and stop", async () => {
        const frame = await renderFrame(
            () => (
                <PausePrompt
                    state="paused"
                    cause="the model endpoint has no valid credential"
                    remedy="Run `inflexa up` in a terminal to sign in again."
                    othersWaiting={1}
                    inert
                    onResume={() => {}}
                    onHold={() => {}}
                    onStop={() => {}}
                />
            ),
            { width: 100, height: 8 },
        );
        expect(frame).toContain("The turn is paused");
        expect(frame).toContain("the model endpoint has no valid credential");
        expect(frame).toContain("Run `inflexa up` in a terminal to sign in again.");
        expect(frame).toContain("r resume · s stop");
        expect(frame).toContain("+1 more waiting");
    });

    test("retrying: the next retry, and retry now in place of resume", async () => {
        const frame = await renderFrame(
            () => (
                <PausePrompt
                    state="retrying"
                    cause="the model provider is not available"
                    nextRetry="retry 2 at 10:32:05"
                    othersWaiting={0}
                    inert
                    onResume={() => {}}
                    onHold={() => {}}
                    onStop={() => {}}
                />
            ),
            { width: 100, height: 8 },
        );
        expect(frame).toContain("The turn waits to retry");
        expect(frame).toContain("next: retry 2 at 10:32:05");
        expect(frame).toContain("r retry now · h hold · s stop");
        expect(frame).not.toContain("more waiting");
    });
});

describe("PausePrompt keys", () => {
    test("unfocused, r types into the editor; focused, r resumes and s stops", async () => {
        let box: BoxRenderable | null = null;
        let ta: TextareaRenderable | null = null;
        const actions: string[] = [];
        const setup = await testRender(
            () => (
                <Harness
                    withEditor
                    onBox={(r) => (box = r)}
                    onTa={(r) => (ta = r)}
                    onResume={() => actions.push("resume")}
                    onStop={() => actions.push("stop")}
                />
            ),
            { width: 80, height: 12 },
        );
        const settle = settleOf(setup);
        try {
            await settle();
            expect(ta!.focused).toBe(true);
            setup.mockInput.pressKey("r");
            await settle();
            expect(ta!.editBuffer.getText()).toBe("r");
            expect(actions).toEqual([]);

            box!.focus();
            await settle();
            setup.mockInput.pressKey("r");
            await settle();
            setup.mockInput.pressKey("s");
            await settle();
            expect(actions).toEqual(["resume", "stop"]);
            expect(ta!.editBuffer.getText()).toBe("r");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("retrying, h holds the work; paused, h does nothing", async () => {
        for (const state of ["retrying", "paused"] as const) {
            let box: BoxRenderable | null = null;
            const actions: string[] = [];
            const setup = await testRender(
                () => <Harness state={state} onBox={(r) => (box = r)} onHold={() => actions.push("hold")} onStop={() => actions.push("stop")} />,
                { width: 80, height: 12 },
            );
            const settle = settleOf(setup);
            try {
                await settle();
                box!.focus();
                await settle();
                setup.mockInput.pressKey("h");
                await settle();
                expect(actions).toEqual(state === "retrying" ? ["hold"] : []);
            } finally {
                setup.renderer.destroy();
            }
        }
    });

    test("busy: the keys do nothing, thus a second press cannot send the resume again", async () => {
        let box: BoxRenderable | null = null;
        const actions: string[] = [];
        const setup = await testRender(
            () => <Harness busy onBox={(r) => (box = r)} onResume={() => actions.push("resume")} onStop={() => actions.push("stop")} />,
            { width: 80, height: 12 },
        );
        const settle = settleOf(setup);
        try {
            await settle();
            box!.focus();
            await settle();
            setup.mockInput.pressKey("r");
            setup.mockInput.pressKey("s");
            await settle();
            expect(actions).toEqual([]);
        } finally {
            setup.renderer.destroy();
        }
    });
});
