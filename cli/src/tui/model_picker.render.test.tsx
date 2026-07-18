import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";

import "../extensions/index.ts"; // installs Response.prototype.jsonWith, which validateModelSelection uses
import { renderFrame } from "../test_support/tui.ts";
import { DialogShowcase } from "./components/dialog/dialog_host.tsx";
import { commands, ModelPickerDialog, modelCommitDecision, runModelCommit } from "./commands.tsx";
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
