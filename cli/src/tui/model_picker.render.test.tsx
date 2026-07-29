import { afterEach, describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import type { JSX } from "solid-js";
import { testRender } from "@opentui/solid";

import "../extensions/index.ts"; // installs Response.prototype.jsonWith, which validateModelSelection uses
import { renderFrame } from "../test_support/tui.ts";
import { GLYPHS } from "../lib/design_system.ts";
import { useKeymapRoot } from "./keymap.ts";
import { DialogOverlay, DialogShowcase, dialogClear, dialogIsOpen, dialogPush } from "./components/dialog/dialog_host.tsx";
import { commands, ModelPickerDialog, modelCommitDecision, modelPickerItems, runModelCommit } from "./commands.tsx";
import { validateModelSelection, type ValidateSelectionSeams } from "../modules/harness/model_listing.ts";
import type { ModelAccess } from "../modules/proxy/models.ts";

// The picker's whole job is to present the RIGHT surface for the listing outcome: a SelectDialog over the
// live models with the agent's current one marked, OR — when listing failed (`models === null`) — a
// PromptDialog free-text field. Both underlying dialogs are covered elsewhere; what is only observable
// through a render is WHICH surface the picker chooses and that it marks/pre-fills the current model.
// Rendered inert (DialogShowcase gives the null entry handle) so exhibits grab no focus, per the gallery.

const noop = (): void => {};
// The picking-phase exhibits never commit, so validate is unreachable at rest — a stub keeps the surface inert.
const validateNoop = async (): Promise<ModelAccess> => "inconclusive";

function pickerNode(models: readonly string[] | null, current: string) {
    return () => (
        <DialogShowcase>
            <ModelPickerDialog agent="sandbox" models={models} current={current} validate={validateNoop} onCommit={noop} onCancel={noop} />
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

    test("offers a manual-entry row so an unlisted id is reachable even when listing succeeds", async () => {
        const frame = await renderFrame(pickerNode(["claude-opus-4-8", "claude-sonnet-4-5"], "claude-sonnet-4-5"), { width: 80, height: 24 });
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

    test("the chat agent titles its picker for the conversation agent", async () => {
        const frame = await renderFrame(
            () => (
                <DialogShowcase>
                    <ModelPickerDialog agent="conversation" models={["claude-opus-4-8"]} current="" validate={validateNoop} onCommit={noop} onCancel={noop} />
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
                    <ModelPickerDialog agent="utility" models={["claude-haiku-4-5"]} current="" validate={validateNoop} onCommit={noop} onCancel={noop} />
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
        const items = modelPickerItems(["claude-opus-4-8", "claude-sonnet-4-5"], "claude-sonnet-4-5");
        expect(items.map((i) => i.value)).toEqual(["claude-opus-4-8", "claude-sonnet-4-5", "__manual__"]);
        expect(items.filter((i) => i.pinned).map((i) => i.value)).toEqual(["__manual__"]);
        expect(items.find((i) => i.hint === "current")?.value).toBe("claude-sonnet-4-5");
    });

    // A described row costs the cursor its visibility here — see modelPickerItems. Pinned as data because the
    // symptom (a row scrolled off-screen under its own description) only appears at one dialog height.
    test("no row carries a description", () => {
        expect(modelPickerItems(["claude-opus-4-8"], "claude-opus-4-8").some((i) => i.description !== undefined)).toBe(false);
    });

    test("an empty listing still offers the escape hatch", () => {
        expect(modelPickerItems([], "claude-opus-4-8").map((i) => i.value)).toEqual(["__manual__"]);
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
        const committed: string[] = [];
        let cancelled = false;
        const setup = await testRender(() => <Harness />, { width: 80, height: 24 });
        const settle = makeSettle(setup);
        try {
            await settle();
            dialogPush(() => (
                <ModelPickerDialog
                    agent="sandbox"
                    models={["claude-opus-4-8", "claude-sonnet-4-5"]}
                    current="claude-sonnet-4-5"
                    validate={validateNoop}
                    onCommit={(m) => committed.push(m)}
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
        const many = Array.from({ length: 13 }, (_, i) => `claude-model-${String(i).padStart(2, "0")}`);
        const setup = await testRender(() => <Harness />, { width: 100, height: 32 });
        const settle = makeSettle(setup);
        try {
            await settle();
            dialogPush(() => (
                <ModelPickerDialog agent="conversation" models={many} current={many[0]!} validate={validateNoop} onCommit={() => {}} onCancel={() => {}} />
            ));
            await settle();
            expect(setup.captureCharFrame()).toContain(`${GLYPHS.chevronRight} ${many[0]}`);

            setup.mockInput.pressArrow("up");
            await settle();
            expect(setup.captureCharFrame()).toContain(`${GLYPHS.chevronRight} Enter a model id manually`);
        } finally {
            setup.renderer.destroy();
        }
    });
});

// The commit path is validate → decide → (persist | inline-error), extracted from the dialog so the
// decision is testable headlessly (the TUI busy/error rendering is PromptDialog's, covered by the dialog
// gallery). `persist` is the writeAgentModel-bearing effect in production, so "persist not called" is
// "nothing written". Both the listed-pick and free-text paths funnel through the same `runModelCommit`.
describe("model commit decision", () => {
    test("a not_found verdict rejects in-dialog: no persist, an error naming the model", () => {
        const decision = modelCommitDecision("claude-nope", "not_found");
        expect(decision.persist).toBe(false);
        // Narrow to the error arm to read its message (persist:false carries the inline error text).
        if (decision.persist) throw new Error("expected a rejection");
        expect(decision.error).toContain("claude-nope");
        expect(decision.error.toLowerCase()).toContain("account");
    });

    test("served and inconclusive both persist (inconclusive-accept)", () => {
        expect(modelCommitDecision("claude-opus-4-8", "served")).toEqual({ persist: true });
        expect(modelCommitDecision("claude-opus-4-8", "inconclusive")).toEqual({ persist: true });
    });
});

describe("runModelCommit — validate then persist-or-report", () => {
    function recordingEffects(access: ModelAccess) {
        const persisted: string[] = [];
        const errors: string[] = [];
        return {
            persisted,
            errors,
            effects: {
                validate: async (): Promise<ModelAccess> => access,
                persist: (m: string): void => void persisted.push(m),
                reportError: (message: string): void => void errors.push(message),
            },
        };
    }

    test("not_found reports the error and never persists", async () => {
        const rec = recordingEffects("not_found");
        await runModelCommit("claude-nope", rec.effects);
        expect(rec.persisted).toEqual([]);
        expect(rec.errors[0]).toContain("claude-nope");
    });

    test("served persists and never reports", async () => {
        const rec = recordingEffects("served");
        await runModelCommit("claude-opus-4-8", rec.effects);
        expect(rec.persisted).toEqual(["claude-opus-4-8"]);
        expect(rec.errors).toEqual([]);
    });

    test("inconclusive persists (a flaky/absent validation route never blocks a switch)", async () => {
        const rec = recordingEffects("inconclusive");
        await runModelCommit("claude-opus-4-8", rec.effects);
        expect(rec.persisted).toEqual(["claude-opus-4-8"]);
        expect(rec.errors).toEqual([]);
    });

    // End-to-end for the openai-compatible protocol: the real validator short-circuits to inconclusive
    // with NO request, and the commit persists — proving the spec's "commits as before, no validation
    // request exists" on that protocol through the actual commit path (not a stubbed verdict).
    test("openai-compatible commits without issuing any validation request", async () => {
        let fetchCount = 0;
        let checked = 0;
        const seams: ValidateSelectionSeams = {
            resolveConnection: () => ({ mode: "direct", provider: "openai", baseURL: "https://api.example.com/v1", protocol: "openai-compatible", agents: {} }),
            readProxyKey: async () => ok("sk-proxy"),
            readModelApiKey: () => "sk-direct",
            resolveAuthCredential: () => {
                throw new Error("resolveAuthCredential must not be called without an auth block");
            },
            checkModelAccess: async () => {
                checked++;
                return "served";
            },
            fetch: async () => {
                fetchCount++;
                return new Response("{}");
            },
        };
        const persisted: string[] = [];
        await runModelCommit("gpt-4o", {
            validate: (m) => validateModelSelection(m, seams),
            persist: (m) => void persisted.push(m),
            reportError: () => {
                throw new Error("openai-compatible must not report an error");
            },
        });
        expect(persisted).toEqual(["gpt-4o"]);
        expect(fetchCount).toBe(0);
        expect(checked).toBe(0);
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
