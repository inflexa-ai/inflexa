import { describe, expect, test } from "bun:test";

import { renderFrame } from "../test_support/tui.ts";
import { DialogShowcase } from "./components/dialog/dialog_host.tsx";
import { commands, ModelPickerDialog } from "./commands.tsx";

// The picker's whole job is to present the RIGHT surface for the listing outcome: a SelectDialog over the
// live models with the agent's current one marked, OR — when listing failed (`models === null`) — a
// PromptDialog free-text field. Both underlying dialogs are covered elsewhere; what is only observable
// through a render is WHICH surface the picker chooses and that it marks/pre-fills the current model.
// Rendered inert (DialogShowcase gives the null entry handle) so exhibits grab no focus, per the gallery.

const noop = (): void => {};

function pickerNode(models: readonly string[] | null, current: string) {
    return () => (
        <DialogShowcase>
            <ModelPickerDialog agent="sandbox" models={models} current={current} onSubmit={noop} onCancel={noop} />
        </DialogShowcase>
    );
}

describe("ModelPickerDialog", () => {
    test("lists the connection's models and marks the agent's current one", async () => {
        const frame = await renderFrame(pickerNode(["claude-opus-4-8", "claude-sonnet-4-5", "claude-haiku-4-5"], "claude-sonnet-4-5"), {
            width: 80,
            height: 24,
        });
        expect(frame).toContain("Switch sandbox model");
        expect(frame).toContain("claude-opus-4-8");
        expect(frame).toContain("claude-sonnet-4-5");
        expect(frame).toContain("claude-haiku-4-5");
        expect(frame).toContain("current"); // the SelectItem hint on the active model
    });

    test("listing failure degrades to a free-text field pre-filled with the current model", async () => {
        const frame = await renderFrame(pickerNode(null, "claude-opus-4-8"), { width: 80, height: 24 });
        expect(frame).toContain("Switch sandbox model");
        expect(frame).toContain("Could not list the connection's models");
        // The current model is pre-filled so the user can edit rather than retype it.
        expect(frame).toContain("claude-opus-4-8");
    });

    test("the chat agent titles its picker for the conversation agent", async () => {
        const frame = await renderFrame(
            () => (
                <DialogShowcase>
                    <ModelPickerDialog agent="conversation" models={["claude-opus-4-8"]} current="" onSubmit={noop} onCancel={noop} />
                </DialogShowcase>
            ),
            { width: 80, height: 24 },
        );
        expect(frame).toContain("Switch chat model");
    });
});

// The model-switch commands live in their own `Provider` palette group, not under `View`. Palette
// group order is derived from a category's first appearance in the `commands` array, so pinning both
// the category and its position past the last `View` command guards the intended "Provider is its own
// group near the end" placement against an accidental re-home.
describe("model-switch command categorisation", () => {
    test("both switch commands sit in the Provider category", () => {
        const chat = commands.find((c) => c.id === "model.switch-chat");
        const sandbox = commands.find((c) => c.id === "model.switch-sandbox");
        expect(chat?.category).toBe("Provider");
        expect(sandbox?.category).toBe("Provider");
    });

    test("Provider first appears after the last View command", () => {
        const lastView = commands.map((c) => c.category).lastIndexOf("View");
        const firstProvider = commands.findIndex((c) => c.category === "Provider");
        expect(lastView).toBeGreaterThanOrEqual(0);
        expect(firstProvider).toBeGreaterThan(lastView);
    });
});
