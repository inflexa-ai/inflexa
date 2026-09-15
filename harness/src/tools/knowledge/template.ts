/**
 * `knowledge_template` — the model emits slot values, and the tool writes the
 * rendered script and the decision record into the step workspace through
 * the same mutator seam as `write_file`. The script is never output tokens.
 *
 * The farm versions ride from the tool, not from the model: the tool reads
 * the `inflexa.lock` of the farm when the host names one, and the service
 * answers with the environment match, which the decision record keeps.
 *
 * The plan settings ride from the host, not from the model: the step input
 * carries a `TemplateBinding` when the plan step grounds on a template, and
 * the tool merges the bound slots under the model values. A model value that
 * differs from a bound value is refused before the service call unless an
 * `overrides` entry names the slot with a reason, and the decision record
 * keeps the bound slots and the overrides beside the script path.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { readFarmLockFile } from "../../sandbox/farm.js";
import { defineTool, type ToolError } from "../define-tool.js";
import type { WorkspaceMutator, WriteFileResult } from "../workspace/mutator.js";
import type { FarmPackage, KnowledgeClient, KnowledgeRejected, KnowledgeUnavailable } from "./client.js";

/** A slot value the plan binds: a scalar, or a list of strings. JSON-serialisable, as the durable step input needs. */
export type TemplateBindingValue = string | number | boolean | readonly string[];

/**
 * The plan settings bound to the template of one step, composed by the host
 * at dispatch and carried on the durable step input. `slots` holds the bound
 * value per slot name, and `sources` the source of each value (a doi, a
 * document, or the plan) under the same name.
 */
export interface TemplateBinding {
    /** The template reference of the plan step, with its version, for example `tpl-deseq2-two-group@1.0.0`. */
    readonly template: string;
    readonly slots: Readonly<Record<string, TemplateBindingValue>>;
    readonly sources: Readonly<Record<string, string>>;
}

export interface KnowledgeTemplateDeps {
    readonly client: KnowledgeClient;
    readonly mutator: WorkspaceMutator;
    /** Host path of the farm `inflexa.lock`. Absent, the environment match reads as unknown. */
    readonly farmLockFile?: string;
    /** The plan settings bound to the template of the step. Absent, the model values ride alone. */
    readonly binding?: TemplateBinding;
}

/** The path of the decision record inside the step. The existing write-file provenance hashes it. */
export const DECISION_RECORD_PATH = "output/decision_record.json";

/** One bound slot as the decision record keeps it. */
export interface BoundSlotRecord {
    readonly slot: string;
    readonly value: TemplateBindingValue;
    readonly source: string;
}

/** One change of a bound value that an `overrides` entry declared, as the decision record keeps it. */
export interface SettingsOverrideRecord {
    readonly slot: string;
    readonly plan_value: TemplateBindingValue;
    readonly new_value: unknown;
    readonly reason: string;
}

export type KnowledgeTemplateOutput =
    | {
          readonly status: "ok";
          readonly script_path: string;
          readonly decision_record_path: string;
          readonly template: {
              readonly id: string;
              readonly version: string;
              readonly label: string;
              readonly method: { readonly id: string; readonly label: string };
              readonly substitute_for?: { readonly id: string; readonly label: string };
          };
          readonly snapshot: { readonly date: string; readonly digest: string };
          readonly slots: readonly {
              readonly name: string;
              readonly value: unknown;
              readonly source: string;
              readonly adaptable: boolean;
              readonly lines: readonly number[];
          }[];
          readonly environment_match: string;
          readonly syntax: string;
          readonly expected_outputs: readonly { readonly name: string; readonly path: string; readonly description?: string }[];
          readonly run_with: string;
      }
    | { readonly status: "write_refused"; readonly path: string; readonly reason: Exclude<WriteFileResult["status"], "ok"> }
    | KnowledgeUnavailable
    | KnowledgeRejected;

function farmPackages(lockPath: string | undefined): FarmPackage[] | undefined {
    if (!lockPath) return undefined;
    const lock = readFarmLockFile(lockPath);
    if (lock.isErr()) return undefined;
    return lock.value.packages.map((pkg) => ({ name: pkg.name, version: pkg.version }));
}

const TEMPLATE_REF = /^tpl-[a-z0-9-]+(@\d+\.\d+\.\d+)?$/;

/** A model value equals a bound value when the scalars are identical, or when two lists hold the same strings in order. */
function sameValue(bound: TemplateBindingValue, value: unknown): boolean {
    if (Array.isArray(bound)) {
        return Array.isArray(value) && value.length === bound.length && bound.every((item, index) => item === value[index]);
    }
    return bound === value;
}

/** The source of a bound slot as the issue names it. A binding without a source for the slot reads as the plan. */
function sourceOf(binding: TemplateBinding, slot: string): string {
    return binding.sources[slot] ?? "plan";
}

/**
 * The refusal of a render request against the binding, or `undefined` when
 * the request obeys it. A different template reference is one issue on the
 * field `template`. Each bound slot whose model value differs without an
 * override is one issue that names the slot, the bound value, and its source.
 */
function refusedByBinding(
    binding: TemplateBinding,
    template: string,
    slots: Readonly<Record<string, unknown>>,
    overridden: ReadonlySet<string>,
): KnowledgeRejected | undefined {
    if (template !== binding.template) {
        const message = `the plan binds the template ${binding.template}; this step renders that reference only`;
        return { match: "rejected", message, issues: [{ field: "template", message, permitted: [binding.template] }] };
    }
    const issues: KnowledgeRejected["issues"][number][] = [];
    for (const [slot, bound] of Object.entries(binding.slots)) {
        const value = slots[slot];
        if (value === undefined || sameValue(bound, value) || overridden.has(slot)) continue;
        const shown = JSON.stringify(bound);
        issues.push({
            slot,
            reason: "bound by the plan",
            message: `the plan binds ${slot} = ${shown} (${sourceOf(binding, slot)}); send that value, or name the slot in overrides with the reason for the change`,
            permitted: [shown],
        });
    }
    if (issues.length === 0) return undefined;
    return { match: "rejected", message: "one or more slot values differ from the plan settings without an override", issues };
}

export function createKnowledgeTemplateTool(deps: KnowledgeTemplateDeps) {
    return defineTool({
        id: "knowledge_template",
        // The mutator wraps the disk mutation in `ctx.runStep` itself, the same as
        // `write_file`, thus the body runs unwrapped in the workflow body.
        executionMode: "workflow",
        description:
            "Render a tested analysis script from a knowledge template and write it into your working directory. " +
            "Use it for a step whose briefing names a template in its Grounding (for example `tpl-deseq2-two-group@1.0.0`). " +
            "The briefing lists the slots of the template and the values the plan binds. " +
            "Send the template id and the slot values only: the file paths of your inputs (absolute `/<analysisId>/...` paths), the column names, the levels of the contrast, and the design. " +
            "A bound value rides into the script as it is; send it unchanged, or omit it. To change a bound value, send the new value and add an `overrides` entry with the slot and the reason. A changed value without an override is refused before the service call. " +
            "Do not write the script yourself. The tool writes `scripts/<template>.R` or `scripts/<template>.py` and `output/decision_record.json` (the template, the snapshot, each slot with its source, the bound slots, the overrides, the environment match, and the citations), then you run the script with `execute_command` using the command in `run_with`. " +
            "A slot value the template refuses comes back as `match: rejected` with the slot and the permitted values; correct it and call again. " +
            "A change the slots do not cover: use `edit_file` on a line marked `# [adaptable: ...]` in the rendered script, and keep the edit small. " +
            "`match: unavailable` means the service did not answer; then write the script yourself as you would without this tool.",
        inputSchema: z.object({
            template: z
                .string()
                .regex(TEMPLATE_REF, "a template id, optionally with @version")
                .describe("The template id from the Grounding of the step, with its version, for example `tpl-deseq2-two-group@1.0.0`."),
            slots: z
                .record(z.string(), z.unknown())
                .describe(
                    "The slot values, by slot name. Only the adaptable slots of the template; a pinned slot is refused. Strings, numbers, booleans, and lists of strings.",
                ),
            overrides: z
                .array(
                    z.object({
                        slot: z.string().min(1).describe("The name of the bound slot whose value you change."),
                        reason: z.string().min(1).describe("Why the plan value does not hold for this step, in one sentence."),
                    }),
                )
                .optional()
                .describe("One entry per bound slot whose value you change from the plan value. Absent when you send every bound value as it is."),
            script_name: z
                .string()
                .regex(/^[A-Za-z0-9_.-]+$/)
                .optional()
                .describe("The file name under `scripts/`. Defaults to `<template id>.R` or `<template id>.py` by the language of the template."),
        }),
        describeCall: ({ template }) => template,
        describeResult: (_input, result: KnowledgeTemplateOutput) =>
            "status" in result ? (result.status === "ok" ? `${result.script_path} (${result.environment_match})` : result.status) : result.match,
        execute: async ({ template, slots, overrides, script_name }, ctx): Promise<Result<KnowledgeTemplateOutput, ToolError>> => {
            const binding = deps.binding;
            const reasons = new Map((overrides ?? []).map((entry) => [entry.slot, entry.reason]));
            if (binding) {
                const refused = refusedByBinding(binding, template, slots, new Set(reasons.keys()));
                if (refused) return ok(refused);
            }
            const merged: Record<string, unknown> = { ...(binding?.slots ?? {}), ...slots };

            const answer = await deps.client.render(template, merged, farmPackages(deps.farmLockFile));
            // A rendered answer carries `ok: true`; the two refusals carry `match` and no `ok`.
            if (!("ok" in answer)) return ok(answer);

            const scriptPath = `scripts/${script_name ?? `${answer.template.id}.${answer.template.language === "R" ? "R" : "py"}`}`;
            const write = (path: string, content: string) =>
                deps.mutator.writeFile({
                    path,
                    content,
                    toolName: "knowledge_template",
                    invocationId: ctx.invocationId,
                    runStep: ctx.runStep,
                    session: ctx.session,
                });

            const scriptWrite = await write(scriptPath, answer.script);
            if (scriptWrite.status !== "ok") return ok({ status: "write_refused", path: scriptWrite.path, reason: scriptWrite.status });

            const boundSlots: BoundSlotRecord[] = Object.entries(binding?.slots ?? {}).map(([slot, value]) => ({
                slot,
                value,
                source: binding ? sourceOf(binding, slot) : "plan",
            }));
            const settingsOverrides: SettingsOverrideRecord[] = boundSlots.flatMap(({ slot, value }) => {
                const reason = reasons.get(slot);
                const sent = slots[slot];
                if (reason === undefined || sent === undefined || sameValue(value, sent)) return [];
                return [{ slot, plan_value: value, new_value: sent, reason }];
            });
            const record = { ...answer.decision_record, script_path: scriptWrite.path, bound_slots: boundSlots, settings_overrides: settingsOverrides };
            const recordWrite = await write(DECISION_RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`);
            if (recordWrite.status !== "ok") return ok({ status: "write_refused", path: recordWrite.path, reason: recordWrite.status });

            return ok({
                status: "ok",
                script_path: scriptWrite.path,
                decision_record_path: recordWrite.path,
                template: {
                    id: answer.template.id,
                    version: answer.template.version,
                    label: answer.template.label,
                    method: { id: answer.template.method.id, label: answer.template.method.label },
                    ...(answer.template.substitute_for
                        ? { substitute_for: { id: answer.template.substitute_for.id, label: answer.template.substitute_for.label } }
                        : {}),
                },
                snapshot: answer.snapshot,
                slots: answer.slots,
                environment_match: answer.environment.match,
                syntax: answer.syntax.status,
                expected_outputs: answer.outputs,
                run_with: `${answer.template.language === "R" ? "Rscript" : "python3"} ${scriptPath}`,
            });
        },
    });
}
