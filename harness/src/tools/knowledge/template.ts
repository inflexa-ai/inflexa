/**
 * `knowledge_template` — the model emits slot values, and the tool writes the
 * rendered script and the decision record into the step workspace through
 * the same mutator seam as `write_file`. The script is never output tokens.
 *
 * The installed versions ride from the tool, not from the model: the tool
 * reads the `inflexa.lock` of the farm and the `image-packages.json` of the
 * store when the host names them (`installedPackages`), and the service
 * answers with the environment match, which the decision record keeps.
 *
 * The plan settings ride from the host, not from the model: the step input
 * carries a `TemplateBinding` when the plan step grounds on a template, and
 * the tool merges the bound slots under the model values. A model value that
 * differs from a bound value is refused before the service call unless an
 * `overrides` entry names the slot with a reason, and the decision record
 * keeps the bound slots and the overrides beside the script path.
 *
 * The facts of the machine never ride at all: a local slot of the template
 * (a path, a column name, a level label, a design formula) is split off the
 * request, the service renders it as its marker, and the tool binds the
 * value on the machine before it writes the file. The request carries the
 * step, its claims, and the release digest the plan pinned, thus the record
 * binds the cited decision to the bytes, and a service on another release
 * refuses the render instead of moving the plan in silence. The render call
 * runs in a durable step, thus a replay writes the same bytes.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { decisionRecordPath, scriptSha256 } from "../workspace/decision-record.js";
import type { WorkspaceMutator, WriteFileResult } from "../workspace/mutator.js";
import type { KnowledgeClient, KnowledgeRejected, KnowledgeSnapshotMismatch, KnowledgeUnavailable, TemplateContract, TemplateParameter } from "./client.js";
import { installedPackages } from "./environment.js";
import { bindLocalSlots, localParameters, validateLocalSlot, type BoundLocalSlot } from "./local-slots.js";

/** A slot value the plan binds: a scalar, or a list of strings. JSON-serialisable, as the durable step input needs. */
export type TemplateBindingValue = string | number | boolean | readonly string[];

/**
 * The plan settings bound to the template of one step, composed by the host
 * at dispatch and carried on the durable step input. `slots` holds the bound
 * value per slot name, and `sources` the source of each value (a doi, a
 * document, or the plan) under the same name. The rest binds the render to
 * the plan step: its id, its claims, the release the plan pinned, and the
 * local slots of the contract that the tool binds on the machine.
 */
export interface TemplateBinding {
    /** The template reference of the plan step, with its version, for example `tpl-deseq2-two-group@1.0.0`. */
    readonly template: string;
    readonly slots: Readonly<Record<string, TemplateBindingValue>>;
    readonly sources: Readonly<Record<string, string>>;
    /** The id of the plan step. */
    readonly step?: string;
    /** The claims of the plan step, as `knowledge_recommend` returned them. */
    readonly claims?: readonly string[];
    /** The release digest the plan pinned. Absent when the step is ungrounded. */
    readonly snapshot?: string;
    /** The local slots of the served contract. Absent on a binding made before the contract carried the flag. */
    readonly local?: readonly TemplateParameter[];
    /** The names of every adaptable slot of the served contract, thus the tool refuses an unknown name before anything leaves the machine. */
    readonly adaptable?: readonly string[];
}

export interface KnowledgeTemplateDeps {
    readonly client: KnowledgeClient;
    readonly mutator: WorkspaceMutator;
    /** Host path of the farm `inflexa.lock`. Absent with no image record, the environment match reads as unknown. */
    readonly farmLockFile?: string;
    /** Host path of the `image-packages.json` of the store: the packages the sandbox image ships, among them the R packages of the R runtime. */
    readonly imagePackagesFile?: string;
    /** The plan settings bound to the template of the step. Absent, the model values ride alone. */
    readonly binding?: TemplateBinding;
}

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
              readonly value?: unknown;
              readonly source: string;
              readonly adaptable: boolean;
              readonly lines: readonly number[];
          }[];
          /** The local slots the tool bound on this machine. */
          readonly local_slots: readonly string[];
          /** The digest of the script as written. */
          readonly written_sha256: string;
          readonly environment_match: string;
          readonly syntax: string;
          readonly expected_outputs: readonly { readonly name: string; readonly path: string; readonly description?: string }[];
          readonly run_with: string;
      }
    | { readonly status: "write_refused"; readonly path: string; readonly reason: Exclude<WriteFileResult["status"], "ok"> }
    | KnowledgeUnavailable
    | KnowledgeRejected
    | KnowledgeSnapshotMismatch;

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

/** A contract answer that is a refusal. The contract itself is a loose object, thus `in` alone cannot tell the two apart. */
function isContractRefusal(answer: TemplateContract | KnowledgeUnavailable | KnowledgeRejected): answer is KnowledgeUnavailable | KnowledgeRejected {
    return "match" in answer && (answer.match === "unavailable" || answer.match === "rejected");
}

/** One slot as the record and the answer report it: a service entry, or a local slot as bound here. */
interface ReportedSlot {
    readonly name: string;
    readonly value?: unknown;
    readonly source: string;
    readonly adaptable: boolean;
    readonly lines: readonly number[];
    readonly read?: boolean;
}

/** The slots of `slots` whose names are in `names`, and the rest, as two records. */
function splitSlots(slots: Readonly<Record<string, unknown>>, names: ReadonlySet<string>): { local: Record<string, unknown>; remote: Record<string, unknown> } {
    const local: Record<string, unknown> = {};
    const remote: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(slots)) (names.has(name) ? local : remote)[name] = value;
    return { local, remote };
}

export function createKnowledgeTemplateTool(deps: KnowledgeTemplateDeps) {
    return defineTool({
        id: "knowledge_template",
        // The mutator wraps the disk mutation in `ctx.runStep` itself, the same as
        // `write_file`, and the render call is wrapped here, thus the body runs
        // unwrapped in the workflow body.
        executionMode: "workflow",
        description:
            "Render a tested analysis script from a knowledge template and write it into your working directory. " +
            "Use it for a step whose briefing names a template in its Grounding (for example `tpl-deseq2-two-group@1.0.0`). " +
            "The briefing lists the slots of the template and the values the plan binds. " +
            "Send the template id and the slot values only: the file paths of your inputs (absolute `/<analysisId>/...` paths), the column names, the levels of the contrast, and the design. " +
            "A slot the briefing marks local (a path, a column name, a level, a formula) is bound on this machine and never sent to the service; send it as any other slot. " +
            "A bound value rides into the script as it is; send it unchanged, or omit it. To change a bound value, send the new value and add an `overrides` entry with the slot and the reason. A changed value without an override is refused before the service call. " +
            "Prefer the template over a script of your own: it is tested, and it carries the settings of the plan. When the template does not fit the step (a design it does not cover, or an input it cannot read), write the script yourself with `write_file`, and state the reason in your summary. " +
            "The tool writes `scripts/<template>.R` or `scripts/<template>.py` and `output/decision_record_<script>.json`, one record per rendered script (the step, its claims, the template, the snapshot, each slot with its source, the bound slots, the overrides, the environment match, the citations, and the digest of the script as written), then you run the script with `execute_command` using the command in `run_with`. " +
            "A slot value the template refuses comes back as `match: rejected` with the slot and the permitted values; correct it and call again. " +
            "A change the slots do not cover: use `edit_file` on a line marked `# [adaptable: ...]` in the rendered script, and keep the edit small; the record lists each such edit. " +
            "`match: unavailable` means the service did not answer, and `match: snapshot_mismatch` means the service moved to another release than the plan pinned; in both cases write the script yourself as you would without this tool, and state it in your summary.",
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

            // The local slots and the adaptable names come from the binding the host composed at dispatch, else from
            // the contract itself. Without them no free-text value can be told from a fact of the machine, and an
            // unknown name could carry one, thus no render happens without them.
            let locals: readonly TemplateParameter[];
            let adaptable: readonly string[];
            if (binding?.local && binding.adaptable) {
                locals = binding.local;
                adaptable = binding.adaptable;
            } else {
                const contract = await ctx.runStep("knowledge_template:contract", () => deps.client.contract(template));
                if (isContractRefusal(contract)) return ok(contract);
                locals = localParameters(contract.parameters);
                adaptable = contract.parameters.filter((parameter) => parameter.adaptable).map((parameter) => parameter.name);
            }
            const unknown = Object.keys(slots).filter((name) => !adaptable.includes(name));
            if (unknown.length > 0) {
                return ok({
                    match: "rejected",
                    message: "one or more slot names are not adaptable slots of this template",
                    issues: unknown.map((slot) => ({ slot, reason: "the template has no such adaptable slot", permitted: [...adaptable] })),
                });
            }
            const localNames = new Set(locals.map((parameter) => parameter.name));
            const split = splitSlots(slots, localNames);
            const boundSplit = splitSlots(binding?.slots ?? {}, localNames);
            const merged: Record<string, unknown> = { ...boundSplit.remote, ...split.remote };
            // A bound local slot is bound on the machine like a model value, under the model value.
            const localValues: Record<string, unknown> = { ...boundSplit.local, ...split.local };
            const localByName = new Map(locals.map((parameter) => [parameter.name, parameter]));
            // A local value the contract refuses is refused before the service call, thus a bad path costs no render.
            const localIssues = Object.entries(localValues).flatMap(([name, value]) => {
                const issue = validateLocalSlot(localByName.get(name)!, value);
                return issue ? [issue] : [];
            });
            if (localIssues.length > 0) {
                return ok({ match: "rejected", message: "one or more local slot values are not valid for this template", issues: localIssues });
            }

            // A replay of the step reads the cached answer, thus it binds and writes the same bytes as the first run.
            const answer = await ctx.runStep("knowledge_template:render", () =>
                deps.client.render(template, merged, installedPackages(deps).packages, {
                    ...(binding?.step ? { step: binding.step } : {}),
                    ...(binding?.claims ? { claims: binding.claims } : {}),
                    ...(binding?.snapshot ? { expectedSnapshot: binding.snapshot } : {}),
                }),
            );
            // A rendered answer carries `ok: true`; the refusals carry `match` and no `ok`.
            if (!("ok" in answer)) return ok(answer);

            const bound = bindLocalSlots({ language: answer.template.language, parameters: locals }, answer.script, localValues, answer.slots);
            if (!bound.ok) {
                return ok({ match: "rejected", message: "one or more local slot values are not valid for this template", issues: bound.issues });
            }

            const scriptFile = script_name ?? `${answer.template.id}.${answer.template.language === "R" ? "R" : "py"}`;
            const scriptPath = `scripts/${scriptFile}`;
            const write = (path: string, content: string) =>
                deps.mutator.writeFile({
                    path,
                    content,
                    toolName: "knowledge_template",
                    invocationId: ctx.invocationId,
                    runStep: ctx.runStep,
                    session: ctx.session,
                });

            const scriptWrite = await write(scriptPath, bound.script);
            if (scriptWrite.status !== "ok") return ok({ status: "write_refused", path: scriptWrite.path, reason: scriptWrite.status });

            const boundSlots: BoundSlotRecord[] = Object.entries(binding?.slots ?? {}).map(([slot, value]) => ({
                slot,
                value: value as TemplateBindingValue,
                source: binding ? sourceOf(binding, slot) : "plan",
            }));
            const settingsOverrides: SettingsOverrideRecord[] = boundSlots.flatMap(({ slot, value }) => {
                const reason = reasons.get(slot);
                const sent = slots[slot];
                if (reason === undefined || sent === undefined || sameValue(value, sent)) return [];
                return [{ slot, plan_value: value, new_value: sent, reason }];
            });
            // The slot report of the record: the service entries, with each local marker entry replaced by the slot as
            // bound here. An optional local slot with no value has no entry, as in a full render.
            const boundByName = new Map<string, BoundLocalSlot>(bound.slots.map((slot) => [slot.name, slot]));
            const reportedSlots: ReportedSlot[] = answer.slots.flatMap((slot): ReportedSlot[] => {
                if (slot.source !== "local") return [slot];
                const local = boundByName.get(slot.name);
                return local ? [local] : [];
            });
            const record = {
                ...answer.decision_record,
                slots: reportedSlots,
                script_path: scriptWrite.path,
                written_sha256: scriptSha256(bound.script),
                bound_slots: boundSlots,
                settings_overrides: settingsOverrides,
            };
            const recordWrite = await write(decisionRecordPath(scriptFile), `${JSON.stringify(record, null, 2)}\n`);
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
                slots: reportedSlots,
                local_slots: bound.slots.map((slot) => slot.name),
                written_sha256: record.written_sha256,
                environment_match: answer.environment.match,
                syntax: answer.syntax.status,
                expected_outputs: answer.outputs,
                run_with: `${answer.template.language === "R" ? "Rscript" : "python3"} ${scriptPath}`,
            });
        },
    });
}
