import { afterEach, describe, expect, test } from "bun:test";
import type { JSX } from "solid-js";
import { testRender } from "@opentui/solid";

import { renderFrame } from "../test_support/tui.ts";
import { GLYPHS } from "../lib/design_system.ts";
import { AGENT_EFFORTS } from "../lib/config.ts";
import { useKeymapRoot } from "./keymap.ts";
import { DialogOverlay, DialogShowcase, dialogClear, dialogIsOpen, dialogPush } from "./components/dialog/dialog_host.tsx";
import { commands, effortFor, ModelPickerDialog, modelPickerItems, runModelCommit } from "./commands.tsx";
import type { AgentEffort, AgentSelection, ListedModelView as ListedModel } from "../api/machine.ts";

// The picker's whole job is to present the RIGHT surface for the listing outcome: a SelectDialog over the
// live models with the agent's current one marked, OR — when listing failed (`models === null`) — a
// PromptDialog free-text field. Both underlying dialogs are covered elsewhere; what is only observable
// through a render is WHICH surface the picker chooses and that it marks/pre-fills the current model.
// Rendered inert (DialogShowcase gives the null entry handle) so exhibits grab no focus, per the gallery.

const noop = (): void => {};
// The picking-phase exhibits never commit, so save is unreachable at rest — a stub keeps the surface inert.
const saveNoop = async (): Promise<string | null> => null;

/** Listed models that each offer the same effort ladder — the full one unless the case names another. */
function listed(ids: readonly string[], efforts: readonly AgentEffort[] = AGENT_EFFORTS): ListedModel[] {
    return ids.map((id) => ({ id, efforts: [...efforts] }));
}

function pickerNode(models: readonly ListedModel[] | null, current: string) {
    return () => (
        <DialogShowcase>
            <ModelPickerDialog agent="sandbox" models={models} current={current} currentEffort="medium" save={saveNoop} onSaved={noop} onCancel={noop} />
        </DialogShowcase>
    );
}

describe("ModelPickerDialog", () => {
    test("lists the connection's models and marks the agent's current one", async () => {
        const frame = await renderFrame(pickerNode(listed(["claude-opus-4-8", "claude-sonnet-4-5", "claude-haiku-4-5"]), "claude-sonnet-4-5"), {
            width: 80,
            height: 24,
        });
        expect(frame).toContain("Switch sandbox model");
        expect(frame).toContain("claude-opus-4-8");
        expect(frame).toContain("claude-sonnet-4-5");
        expect(frame).toContain("claude-haiku-4-5");
        expect(frame).toContain("current"); // the SelectItem hint on the active model
    });

    test("offers a manual-entry row so an unlisted id is reachable even when listing succeeds", async () => {
        const frame = await renderFrame(pickerNode(listed(["claude-opus-4-8", "claude-sonnet-4-5"]), "claude-sonnet-4-5"), { width: 80, height: 24 });
        // With a present list the manual-entry row is still offered — the escape hatch to type an id the
        // connection does not enumerate, mirroring direct-setup's always-free-text affordance.
        expect(frame).toContain("Enter a model id manually");
    });

    test("listing failure degrades to a free-text field pre-filled with the current model", async () => {
        const frame = await renderFrame(pickerNode(null, "claude-opus-4-8"), { width: 80, height: 24 });
        expect(frame).toContain("Switch sandbox model");
        expect(frame).toContain("Could not list the connection's models");
        // The current model is pre-filled so the user can edit rather than retype it.
        expect(frame).toContain("claude-opus-4-8");
    });

    test("listing failure names the reason of the server beside the free-text field", async () => {
        const frame = await renderFrame(
            () => (
                <DialogShowcase>
                    <ModelPickerDialog
                        agent="sandbox"
                        models={null}
                        listingFailure="no answer in 10 s"
                        current="claude-opus-4-8"
                        currentEffort="medium"
                        save={saveNoop}
                        onSaved={noop}
                        onCancel={noop}
                    />
                </DialogShowcase>
            ),
            { width: 120, height: 24 },
        );
        expect(frame).toContain("no answer in 10 s");
    });

    test("the chat agent titles its picker for the conversation agent", async () => {
        const frame = await renderFrame(
            () => (
                <DialogShowcase>
                    <ModelPickerDialog
                        agent="conversation"
                        models={listed(["claude-opus-4-8"])}
                        current=""
                        currentEffort="high"
                        save={saveNoop}
                        onSaved={noop}
                        onCancel={noop}
                    />
                </DialogShowcase>
            ),
            { width: 80, height: 24 },
        );
        expect(frame).toContain("Switch chat model");
    });

    test("the utility role has its own picker title", async () => {
        const frame = await renderFrame(
            () => (
                <DialogShowcase>
                    <ModelPickerDialog
                        agent="utility"
                        models={listed(["claude-haiku-4-5"])}
                        current=""
                        currentEffort="medium"
                        save={saveNoop}
                        onSaved={noop}
                        onCancel={noop}
                    />
                </DialogShowcase>
            ),
            { width: 80, height: 24 },
        );
        expect(frame).toContain("Switch utility model");
    });
});

// The row set as DATA: which row carries the manual sentinel, which is marked `current`, and that the
// escape hatch is pinned. Asserting it here — rather than through a frame — is what makes the pin a
// contract of the picker rather than an accident of how a particular list renders.
describe("model picker rows", () => {
    test("the manual-entry row is last, pinned, and the only row that is not a model id", () => {
        const items = modelPickerItems(listed(["claude-opus-4-8", "claude-sonnet-4-5"]), "claude-sonnet-4-5");
        expect(items.map((i) => i.value)).toEqual(["claude-opus-4-8", "claude-sonnet-4-5", "__manual__"]);
        expect(items.filter((i) => i.pinned).map((i) => i.value)).toEqual(["__manual__"]);
        expect(items.find((i) => i.hint === "current")?.value).toBe("claude-sonnet-4-5");
    });

    // A described row costs the cursor its visibility here — see modelPickerItems. Pinned as data because the
    // symptom (a row scrolled off-screen under its own description) only appears at one dialog height.
    test("no row carries a description", () => {
        expect(modelPickerItems(listed(["claude-opus-4-8"]), "claude-opus-4-8").some((i) => i.description !== undefined)).toBe(false);
    });

    test("an empty listing still offers the escape hatch", () => {
        expect(modelPickerItems([], "claude-opus-4-8").map((i) => i.value)).toEqual(["__manual__"]);
    });

    test("the effort hint joins the current mark on the row it names", () => {
        const items = modelPickerItems(listed(["claude-opus-4-8", "claude-sonnet-4-5"]), "claude-sonnet-4-5", (m) =>
            m.id === "claude-sonnet-4-5" ? "high" : undefined,
        );
        expect(items.map((i) => i.hint)).toEqual([undefined, `current ${GLYPHS.middot} high`, undefined]);
    });
});

// The effort a row shows when the picker holds an effort the model may not list. The held effort must
// never show on a model that cannot take it, and must come back on a model that can.
describe("effortFor", () => {
    const model = (efforts: readonly AgentEffort[]): ListedModel => ({ id: "m", efforts: [...efforts] });

    test("a listed effort is kept", () => {
        expect(effortFor(model(AGENT_EFFORTS), "xhigh")).toBe("xhigh");
        expect(effortFor(model(["low", "high"]), "high")).toBe("high");
    });

    test("an unlisted effort clamps to the deepest listed rung below it", () => {
        expect(effortFor(model(["low", "medium", "high"]), "xhigh")).toBe("high");
        expect(effortFor(model(["low", "high"]), "medium")).toBe("low");
    });

    test("with no listed rung below, the shallowest listed rung wins", () => {
        expect(effortFor(model(["high", "xhigh"]), "low")).toBe("high");
    });

    test("a model that lists no effort gives null", () => {
        expect(effortFor(model([]), "medium")).toBeNull();
    });
});

// The picker driven through the REAL dialog host and keyboard bus — the only way to observe the
// behaviors that only exist while a user is typing: that the escape hatch survives a filter query no
// row matches, and that backing out of it returns to the list instead of destroying the picker.
describe("ModelPickerDialog — filtering to an unlisted id (rendered)", () => {
    afterEach(() => {
        dialogClear();
    });

    function Harness(): JSX.Element {
        useKeymapRoot();
        return (
            <box width="100%" height="100%">
                <DialogOverlay />
            </box>
        );
    }

    // A lone ESC byte is an ambiguous escape-sequence prefix — opentui's parser holds it ~20ms before
    // flushing it as a standalone key, so settling on a real clock is required for esc to arrive.
    function makeSettle(setup: { renderOnce: () => Promise<void> }): () => Promise<void> {
        return async () => {
            await new Promise((r) => setTimeout(r, 35));
            await setup.renderOnce();
            await setup.renderOnce();
        };
    }

    test("typing an id the connection does not list keeps the escape hatch; esc returns to the list", async () => {
        const committed: AgentSelection[] = [];
        let cancelled = false;
        const setup = await testRender(() => <Harness />, { width: 80, height: 24 });
        const settle = makeSettle(setup);
        try {
            await settle();
            dialogPush(() => (
                <ModelPickerDialog
                    agent="sandbox"
                    models={listed(["claude-opus-4-8", "claude-sonnet-4-5"])}
                    current="claude-sonnet-4-5"
                    currentEffort="medium"
                    save={(m) => {
                        committed.push(m);
                        return Promise.resolve(null);
                    }}
                    onSaved={noop}
                    onCancel={() => {
                        cancelled = true;
                    }}
                />
            ));
            await settle();

            // The query IS a model id — no listed row and no label shares a subsequence with it.
            await setup.mockInput.typeText("grok-4");
            await settle();
            let frame = setup.captureCharFrame();
            expect(frame).not.toContain("claude-opus-4-8");
            expect(frame).toContain("Enter a model id manually");

            setup.mockInput.pressEnter(); // the escape hatch is the only surviving row, so it is the cursor row
            await settle();
            frame = setup.captureCharFrame();
            expect(frame).toContain("Enter an id this connection does not list");
            expect(frame).not.toContain("claude-sonnet-4-5"); // no pre-fill: the list already showed the current id

            setup.mockInput.pressEscape(); // back to the list — NOT out of the picker
            await settle();
            frame = setup.captureCharFrame();
            expect(dialogIsOpen()).toBe(true);
            expect(cancelled).toBe(false);
            expect(frame).toContain("claude-opus-4-8");

            setup.mockInput.pressEscape(); // from the list, esc means what it always did
            await settle();
            expect(dialogIsOpen()).toBe(false);
            expect(cancelled).toBe(true);
            expect(committed).toEqual([]);
        } finally {
            setup.renderer.destroy();
        }
    });

    // A listing longer than the dialog's fixed height puts the escape hatch below the fold, where the ONLY
    // gesture that reaches it in one stroke is `up` wrapping from the first row. The row must then actually
    // be on screen: a cursor the list scrolled to and then lost is worse than one that never moved, since
    // enter now commits a row the user cannot see.
    test("up from the first row wraps to the escape hatch and scrolls it into view", async () => {
        const many = listed(Array.from({ length: 13 }, (_, i) => `claude-model-${String(i).padStart(2, "0")}`));
        const setup = await testRender(() => <Harness />, { width: 100, height: 32 });
        const settle = makeSettle(setup);
        try {
            await settle();
            dialogPush(() => (
                <ModelPickerDialog
                    agent="conversation"
                    models={many}
                    current={many[0]!.id}
                    currentEffort="high"
                    save={saveNoop}
                    onSaved={() => {}}
                    onCancel={() => {}}
                />
            ));
            await settle();
            expect(setup.captureCharFrame()).toContain(`${GLYPHS.chevronRight} ${many[0]!.id}`);

            setup.mockInput.pressArrow("up");
            await settle();
            expect(setup.captureCharFrame()).toContain(`${GLYPHS.chevronRight} Enter a model id manually`);
        } finally {
            setup.renderer.destroy();
        }
    });

    // The effort is held across cursor moves and clamped to the ladder of the cursor row, thus a model with
    // a shorter ladder commits the rung it can take, not the held one.
    test("right raises the effort of the cursor row, and enter commits the effort the row shows", async () => {
        const committed: AgentSelection[] = [];
        const setup = await testRender(() => <Harness />, { width: 80, height: 24 });
        const settle = makeSettle(setup);
        try {
            await settle();
            dialogPush(() => (
                <ModelPickerDialog
                    agent="sandbox"
                    models={[...listed(["claude-opus-4-8"]), ...listed(["claude-haiku-4-5"], ["low", "medium"])]}
                    current="claude-haiku-4-5"
                    currentEffort="medium"
                    save={(selection) => {
                        committed.push(selection);
                        return Promise.resolve(null);
                    }}
                    onSaved={noop}
                    onCancel={() => {}}
                />
            ));
            await settle();
            expect(setup.captureCharFrame()).toContain(`${GLYPHS.arrowLeft} medium ${GLYPHS.arrowRight}`);

            setup.mockInput.pressArrow("right");
            await settle();
            expect(setup.captureCharFrame()).toContain(`${GLYPHS.arrowLeft} high ${GLYPHS.arrowRight}`);

            // The haiku ladder stops at medium, thus the held `high` shows as medium on that row.
            setup.mockInput.pressArrow("down");
            await settle();
            expect(setup.captureCharFrame()).toContain(`${GLYPHS.arrowLeft} medium ${GLYPHS.arrowRight}`);
            setup.mockInput.pressEnter();
            await settle();
            expect(committed).toEqual([{ model: "claude-haiku-4-5", effort: "medium" }]);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("left lowers the effort, and enter commits it on the cursor row", async () => {
        const committed: AgentSelection[] = [];
        const setup = await testRender(() => <Harness />, { width: 80, height: 24 });
        const settle = makeSettle(setup);
        try {
            await settle();
            dialogPush(() => (
                <ModelPickerDialog
                    agent="conversation"
                    models={listed(["claude-opus-4-8"])}
                    current="claude-opus-4-8"
                    currentEffort="high"
                    save={(selection) => {
                        committed.push(selection);
                        return Promise.resolve(null);
                    }}
                    onSaved={noop}
                    onCancel={() => {}}
                />
            ));
            await settle();
            setup.mockInput.pressArrow("left");
            await settle();
            setup.mockInput.pressArrow("left");
            await settle();
            setup.mockInput.pressArrow("left"); // already at the shallowest rung: no change
            await settle();
            expect(setup.captureCharFrame()).toContain(`${GLYPHS.arrowLeft} low ${GLYPHS.arrowRight}`);
            setup.mockInput.pressEnter();
            await settle();
            expect(committed).toEqual([{ model: "claude-opus-4-8", effort: "low" }]);
        } finally {
            setup.renderer.destroy();
        }
    });
});

// The commit path is save → (close | inline-error), extracted from the dialog so the decision is testable
// headlessly (the TUI busy/error rendering is PromptDialog's, covered by the dialog gallery). The server
// validates the model (the agents route test covers the refusal), and `save` gives its inline error.
describe("runModelCommit — save then close-or-report", () => {
    const pick: AgentSelection = { model: "claude-opus-4-8", effort: "high" };

    function recordingEffects(refusal: string | null) {
        const saved: AgentSelection[] = [];
        const errors: string[] = [];
        let closed = 0;
        return {
            saved,
            errors,
            closed: () => closed,
            effects: {
                save: async (selection: AgentSelection): Promise<string | null> => {
                    saved.push(selection);
                    return refusal;
                },
                onSaved: (): void => {
                    closed += 1;
                },
                reportError: (message: string): void => void errors.push(message),
            },
        };
    }

    test("a refused model reports the inline error and stays open", async () => {
        const rec = recordingEffects("This account cannot serve claude-nope. Pick another model, or check your credential.");
        await runModelCommit({ model: "claude-nope", effort: "high" }, rec.effects);
        expect(rec.closed()).toBe(0);
        expect(rec.errors[0]).toContain("claude-nope");
    });

    test("a saved pick closes and never reports", async () => {
        const rec = recordingEffects(null);
        await runModelCommit(pick, rec.effects);
        expect(rec.saved).toEqual([pick]);
        expect(rec.closed()).toBe(1);
        expect(rec.errors).toEqual([]);
    });
});

// The model-switch commands live in their own `Provider` palette group, not under `View`. Palette
// group order is derived from a category's first appearance in the `commands` array, so pinning both
// the category and its position past the last `View` command guards the intended "Provider is its own
// group near the end" placement against an accidental re-home.
describe("model-switch command categorisation", () => {
    test("all three role-switch commands sit in the Provider category", () => {
        const chat = commands.find((c) => c.id === "model.switch-chat");
        const sandbox = commands.find((c) => c.id === "model.switch-sandbox");
        const utility = commands.find((c) => c.id === "model.switch-utility");
        expect(chat?.category).toBe("Provider");
        expect(sandbox?.category).toBe("Provider");
        expect(utility?.category).toBe("Provider");
    });

    test("Provider first appears after the last View command", () => {
        const lastView = commands.map((c) => c.category).lastIndexOf("View");
        const firstProvider = commands.findIndex((c) => c.category === "Provider");
        expect(lastView).toBeGreaterThanOrEqual(0);
        expect(firstProvider).toBeGreaterThan(lastView);
    });
});
