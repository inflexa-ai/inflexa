import { describe, expect, test } from "bun:test";
import { Show } from "solid-js";
import { testRender } from "@opentui/solid";
import type { BoxRenderable, TextareaRenderable } from "@opentui/core";

import { AskPrompt } from "./ask_prompt.tsx";
import { useKeymapRoot } from "../keymap.ts";
import { renderFrame } from "../../test_support/tui.ts";

// Two proofs live here. The static frames (width sweep + short height) show that the docked prompt
// paints its title, exact command, detail, key hints, and the queued-count hint at every terminal
// width. The interactive tests drive the REAL keyboard bus through useKeymapRoot to prove the
// focus-target gate: the prompt's bare y/a/n keys are legal ONLY while it holds focus, and never
// steal characters from a co-mounted, focused editor (the bare-printable rule).

// A lone ESC byte is an ambiguous escape-sequence prefix that opentui's StdinParser holds for ~20ms
// before flushing as a standalone key, so key-driven steps settle on a real clock (matches the
// dialog/scroll render tests). Harmless for single printable keys, so it is used uniformly.
function makeSettle(setup: { renderOnce: () => Promise<void> }): () => Promise<void> {
    return async () => {
        await new Promise((r) => setTimeout(r, 35));
        await setup.renderOnce();
        await setup.renderOnce();
    };
}

/** Mounts the prompt under a keymap root, optionally beside a focus-grabbing editor (the leak test). */
function Harness(props: {
    withEditor?: boolean;
    onBox?: (r: BoxRenderable) => void;
    onTa?: (r: TextareaRenderable) => void;
    onApprove?: (kind: "once" | "always") => void;
    onReject?: (feedback?: string) => void;
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
            <AskPrompt
                title="Run shell command"
                command="rm -rf build"
                queuedCount={0}
                onApprove={(kind) => props.onApprove?.(kind)}
                onReject={(feedback) => props.onReject?.(feedback)}
                onFocusReady={(r) => props.onBox?.(r)}
            />
        </box>
    );
}

describe("AskPrompt choice-mode frame", () => {
    for (const width of [80, 100, 120]) {
        test(`renders title, command, detail, hints, and the queued-count hint at width ${width}`, async () => {
            const frame = await renderFrame(
                () => (
                    <AskPrompt
                        title="Run shell command"
                        command="rm -rf build"
                        detail="Deletes the build directory"
                        queuedCount={2}
                        onApprove={() => {}}
                        onReject={() => {}}
                    />
                ),
                { width, height: 10 },
            );
            expect(frame).toContain("Run shell command");
            expect(frame).toContain("rm -rf build");
            expect(frame).toContain("Deletes the build directory");
            // The hint line reads "y approve · a always · n reject" — assert its words survive the split spans.
            expect(frame).toContain("approve");
            expect(frame).toContain("always");
            expect(frame).toContain("reject");
            expect(frame).toContain("+2 more");
        });
    }

    test("stays legible on a short terminal (no detail, no queue)", async () => {
        const frame = await renderFrame(
            () => <AskPrompt title="Run shell command" command="rm -rf build" queuedCount={0} onApprove={() => {}} onReject={() => {}} />,
            {
                width: 80,
                height: 6,
            },
        );
        expect(frame).toContain("Run shell command");
        expect(frame).toContain("rm -rf build");
        expect(frame).toContain("approve");
        // No queue → no +N hint.
        expect(frame).not.toContain("more");
    });
});

describe("AskPrompt feedback mode", () => {
    test("pressing n reveals the feedback input", async () => {
        let box: BoxRenderable | null = null;
        const setup = await testRender(() => <Harness onBox={(r) => (box = r)} />, { width: 80, height: 12 });
        const settle = makeSettle(setup);
        const frame = () =>
            setup
                .captureCharFrame()
                .split("\n")
                .map((l) => l.trimEnd())
                .join("\n");
        try {
            await settle();
            // Focus the prompt (the host's job in production) so its choice keys are live.
            box!.focus();
            await settle();
            expect(frame()).toContain("n reject");

            setup.mockInput.pressKey("n");
            await settle();
            // The feedback surface: the input's placeholder and the submit/back hint replace the choices.
            expect(frame()).toContain("feedback");
            expect(frame()).toContain("esc back");
            expect(frame()).not.toContain("n reject");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("initialMode feedback seeds the input surface with no key press", async () => {
        // The gallery-exhibit path: the feedback surface renders from the seed alone (inert = the
        // embedded input mounts blurred), so no host focus or keypress is needed to show it.
        const frame = await renderFrame(
            () => (
                <AskPrompt
                    title="Run shell command"
                    command="rm -rf build"
                    queuedCount={0}
                    initialMode="feedback"
                    inert
                    onApprove={() => {}}
                    onReject={() => {}}
                />
            ),
            { width: 80, height: 8 },
        );
        expect(frame).toContain("feedback");
        expect(frame).toContain("esc back");
        expect(frame).not.toContain("n reject");
    });
});

describe("AskPrompt key gating (bare-printable rule)", () => {
    test("unfocused prompt keys go to the editor; focused prompt keys fire onApprove", async () => {
        let box: BoxRenderable | null = null;
        let ta: TextareaRenderable | null = null;
        const approvals: Array<"once" | "always"> = [];
        const setup = await testRender(() => <Harness withEditor onBox={(r) => (box = r)} onTa={(r) => (ta = r)} onApprove={(k) => approvals.push(k)} />, {
            width: 80,
            height: 12,
        });
        const settle = makeSettle(setup);
        try {
            await settle();
            // The editor grabbed focus on mount; the prompt is mounted but unfocused.
            expect(ta!.focused).toBe(true);

            // With the editor focused, y is NOT a prompt key — it types into the editor and never approves.
            setup.mockInput.pressKey("y");
            await settle();
            expect(ta!.editBuffer.getText()).toBe("y");
            expect(approvals).toEqual([]);

            // Focus the prompt: now the same y is captured by the target-gated layer and approves once.
            box!.focus();
            await settle();
            setup.mockInput.pressKey("y");
            await settle();
            expect(approvals).toEqual(["once"]);
            // The editor is blurred and the key was swallowed by the binding — its buffer is untouched.
            expect(ta!.editBuffer.getText()).toBe("y");
        } finally {
            setup.renderer.destroy();
        }
    });
});
