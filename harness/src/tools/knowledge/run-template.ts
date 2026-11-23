/**
 * `run_template` — render the template of a template step and run the script, in one call.
 *
 * The model sends the slot values. The tool renders the template through the template source, writes the script
 * into the working directory of the step through the same `WorkspaceMutator` as `write_file`, and runs it in the
 * sandbox. The script is never output tokens, and the write of the script carries the facts of the render into
 * provenance: the template, the release, each setting with its source, and the overrides.
 *
 * The plan settings ride from the host, not from the model: the step input carries a `TemplateBinding`, and the
 * tool merges the bound slots under the model values. A model value that differs from a bound value is refused
 * before the render unless an `overrides` entry names the slot with a reason.
 *
 * The facts of the machine never leave it: a local slot of the template (a path, a column name, a level label, a
 * design formula) is split off the request, the source renders it as its marker, and the tool binds the value on
 * the machine before it writes the file.
 *
 * The call runs as one durable step, as `execute_command` does: the exec id is the id of that step, thus a replay
 * returns the cached result and runs nothing again.
 */

import { posix as posixPath } from "node:path";

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import type { EnvironmentStorePaths } from "../../config/environment-stores.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import type { Logger } from "../../lib/logger.js";
import type { LoopStep } from "../../loop/run-loop.js";
import { presentGet } from "../../lib/present.js";
import type { ProvenanceCollector } from "../../provenance/collector.js";
import { feedExecFrame } from "../../provenance/exec-frame.js";
import type { TemplateRender } from "../../provenance/types.js";
import type { BoundLease } from "../../sandbox/leases.js";
import type { ProvenanceFrame } from "../../sandbox/types.js";
import { defineTool, withToolCallRecord, type Tool, type ToolError, type WithToolCallRecord } from "../define-tool.js";
import { execNote } from "../workspace/execute-command.js";
import type { WorkspaceMutator, WriteRecord } from "../workspace/mutator.js";
import { boundExecResult, type BoundedExecResult } from "../workspace/result-bounds.js";
import { runSandboxExec } from "../workspace/run-exec.js";
import type { KnowledgeRejected, KnowledgeSnapshotMismatch, KnowledgeUnavailable, TemplateContract, TemplateParameter, TemplateSource } from "./client.js";
import { installedPackages } from "./environment.js";
import { bindLocalSlots, localParameters, validateLocalSlot, type LocalSlotIssue } from "./local-slots.js";

export const RUN_TEMPLATE_TOOL_ID = "run_template";

/** A slot value the plan binds: a scalar, or a list of strings. JSON-serialisable, as the durable step input needs. */
export type TemplateBindingValue = string | number | boolean | readonly string[];

/**
 * The plan settings bound to the template of one step, composed by the host at dispatch and carried on the
 * durable step input. `slots` holds the bound value per slot name, and `sources` the source of each value (a doi,
 * a document, or the plan) under the same name. The rest binds the render to the plan step: its id, its claims,
 * the release the plan pinned, and the local slots of the contract that the tool binds on the machine.
 */
export type TemplateBinding = {
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
    /** The local slots of the served contract. */
    readonly local: readonly TemplateParameter[];
    /** The names of every adaptable slot of the served contract, thus the tool refuses an unknown name before anything leaves the machine. */
    readonly adaptable: readonly string[];
    /** The departures of the plan step from its rules. The host applied each value to `slots` already. */
    readonly departures?: readonly BindingDeparture[];
    /**
     * The adaptable slots that a departure of the plan does not apply. An omitted slot takes the default of the template, thus a
     * render must send a value for each, with an override and its reason.
     */
    readonly excluded?: readonly string[];
};

/** The template of a template step: the reference the plan names, and the plan settings bound to its contract. */
export type StepTemplate = {
    /** The template reference of the plan step, with its version, for example `tpl-deseq2-two-group@1.0.0`. */
    readonly ref: string;
    /** The plan settings bound to the served contract. Absent when the host could not read the contract at dispatch. */
    readonly binding?: TemplateBinding;
};

/** One departure of the plan step from a rule it cites, as the grounding holds it. */
export type BindingDeparture = {
    readonly rule: string;
    readonly setting?: string;
    readonly value?: TemplateBindingValue;
    readonly reason: string;
};

export type RunTemplateDeps = {
    readonly source: TemplateSource;
    /** The template that the plan step names, with its version. The tool renders this reference only. */
    readonly template: string;
    /** The plan settings bound to the template. Absent when the host could not read the contract at dispatch. */
    readonly binding?: TemplateBinding;
    readonly mutator: WorkspaceMutator;
    readonly lease: BoundLease;
    /** In-sandbox absolute path of the working directory: the default directory of the script and of the run. */
    readonly workingDir: string;
    /** Step-scoped lineage collector: the exec frame of the run goes here, as for `execute_command`. */
    readonly lineageCollector?: ProvenanceCollector;
    /** Analysis resource mount root (`/{resourceId}`). */
    readonly mountRoot?: string;
    /** Host path of the farm `inflexa.lock`, or its resolver for each analysis. Absent with no image record, the environment match reads as unknown. */
    readonly farmLockFile?: EnvironmentStorePaths["farmLockFile"];
    /** Host path of the `image-packages.json` of the store: the packages the sandbox image ships, among them the R packages of the R runtime. */
    readonly imagePackagesFile?: string;
    readonly logger?: Logger;
};

/** The answer of a call that rendered the script and ran it. A run with a non-zero exit code is data, as for `execute_command`. */
export type RunTemplateRan = {
    readonly status: "ran";
    readonly script_path: string;
    readonly template: {
        readonly id: string;
        readonly version: string;
        readonly label: string;
        readonly method: { readonly id: string; readonly label: string };
        readonly substitute_for?: { readonly id: string; readonly label: string };
    };
    readonly environment_match: string;
    readonly expected_outputs: readonly { readonly name: string; readonly path: string; readonly description?: string }[];
    readonly note?: string;
} & BoundedExecResult;

export type RunTemplateOutput =
    | RunTemplateRan
    | { readonly status: "write_refused"; readonly path: string; readonly reason: string }
    | KnowledgeUnavailable
    | KnowledgeRejected
    | KnowledgeSnapshotMismatch;

/** What one call leaves for the fold: the write of the script, and the run. */
type RunTemplateCallRecord = {
    readonly write: WriteRecord;
    readonly command: readonly string[];
    readonly scriptPath: string;
    readonly exitCode: number | null;
    readonly durationMs: number | null;
    readonly provenance?: ProvenanceFrame;
};

type RunTemplateResult = RunTemplateOutput | WithToolCallRecord<RunTemplateRan, RunTemplateCallRecord>;

const RanValueSchema = z.looseObject({ status: z.literal("ran"), exitCode: z.literal(0) });

/** True when the recorded calls hold a `run_template` run that ended with exit code 0: the outcome of a template step. */
export function hasSuccessfulTemplateRun(steps: readonly LoopStep[]): boolean {
    return steps.some((step) =>
        step.calls.some(
            (call) => call.toolName === RUN_TEMPLATE_TOOL_ID && call.output?.outcome === "ok" && RanValueSchema.safeParse(call.output.value).success,
        ),
    );
}

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- a relative path of safe file-name segments; the mutator confines it to the working directory.
const SCRIPT_PATH_RE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;

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
 * The refusal of a render request against the binding, or `undefined` when the request obeys it. Each bound slot
 * whose model value differs without an override is one issue that names the slot, the bound value, and its source.
 */
function refusedByBinding(binding: TemplateBinding, slots: Readonly<Record<string, unknown>>, overridden: ReadonlySet<string>): KnowledgeRejected | undefined {
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
    for (const slot of binding.excluded ?? []) {
        if (slots[slot] !== undefined && overridden.has(slot)) continue;
        const departure = binding.departures?.find((entry) => entry.setting === slot);
        const rule = departure === undefined ? "a rule" : `${departure.rule} (${departure.reason})`;
        issues.push({
            slot,
            reason: "not applied by the plan",
            message: `the plan departs from ${rule} and does not apply ${slot}, but the template gives each slot a value; send the value that matches the plan, and name the slot in overrides with the reason`,
        });
    }
    if (issues.length === 0) return undefined;
    return { match: "rejected", message: "one or more slot values differ from the plan settings without an override", issues };
}

/** A contract answer that is a refusal. The contract itself is a loose object, thus `in` alone cannot tell the two apart. */
function isContractRefusal(answer: TemplateContract | KnowledgeUnavailable | KnowledgeRejected): answer is KnowledgeUnavailable | KnowledgeRejected {
    return "match" in answer && (answer.match === "unavailable" || answer.match === "rejected");
}

/** The slots of `slots` whose names are in `names`, and the rest, as two records. */
function splitSlots(slots: Readonly<Record<string, unknown>>, names: ReadonlySet<string>): { local: Record<string, unknown>; remote: Record<string, unknown> } {
    const local: Record<string, unknown> = {};
    const remote: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(slots)) (names.has(name) ? local : remote)[name] = value;
    return { local, remote };
}

/**
 * A refusal of a local value with the description of its slot. A reason such as a failed pattern names the rule,
 * and the description names the intent (a formula that ends with the condition, for example), thus the agent can
 * correct the value in the next call.
 */
function describedIssue(issue: LocalSlotIssue, localByName: ReadonlyMap<string, TemplateParameter>): LocalSlotIssue {
    const description = localByName.get(issue.slot)?.description.trim();
    return description ? { ...issue, reason: `${issue.reason}. The slot: ${description}` } : issue;
}

/** A value of a setting as provenance keeps it: a scalar or a list of strings, else no value. */
function settingValue(value: unknown): TemplateRender["settings"][number]["value"] {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
    return undefined;
}

const RunTemplateInputSchema = z.object({
    slots: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
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
    script_path: z
        .string()
        .regex(SCRIPT_PATH_RE)
        .optional()
        .describe(
            "Where to write the script, relative to your working directory. Defaults to `<template id>.R` or `<template id>.py` by the language of the template.",
        ),
    cwd: z
        .string()
        .optional()
        .describe(
            "The directory the script runs in, relative to your working directory or an absolute '/<analysisId>/...' path. The relative output paths of the template land here. Defaults to your working directory.",
        ),
    timeoutSeconds: z.number().int().positive().optional().describe("The timeout of the run in seconds. Default 3600."),
});

export function createRunTemplateTool(deps: RunTemplateDeps): Tool<z.infer<typeof RunTemplateInputSchema>, RunTemplateResult> {
    const logger = (deps.logger ?? createNoopLogger()).named(RUN_TEMPLATE_TOOL_ID);
    return defineTool({
        id: RUN_TEMPLATE_TOOL_ID,
        ownStep: true,
        description:
            "Render the template of this step with your slot values, write the script into your working directory, and run it in the sandbox. " +
            "The briefing names the template, its slots, and the values the plan binds. A run needs the sandbox, thus acquire it first. " +
            "Send the slot values only: the file paths of your inputs (absolute `/<analysisId>/...` paths), the column names, the levels of the contrast, and the design. " +
            "A bound value rides into the script as it is; send it unchanged, or omit it. To change a bound value, send the new value and add an `overrides` entry with the slot and the reason. " +
            "A slot value that the template refuses comes back as `match: rejected` with the slot and the permitted values; correct it and call again. " +
            "A run that fails is data: read `exitCode` and the streams, correct the inputs or the slot values, and call again. Each call renders and runs the script again. " +
            "`match: unavailable` or `match: snapshot_mismatch` means that the template cannot render now; report the blocker with the reason.",
        inputSchema: RunTemplateInputSchema,
        view: "none",
        describeCall: () => deps.template,
        describeResult: (_input, result: RunTemplateResult) =>
            "status" in result ? (result.status === "ran" ? `exit ${result.exitCode ?? "none"}` : result.status) : result.match,
        execute: async ({ slots, overrides, script_path, cwd, timeoutSeconds }, ctx): Promise<Result<RunTemplateResult, ToolError>> => {
            const binding = deps.binding;
            const reasons = new Map((overrides ?? []).map((entry) => [entry.slot, entry.reason]));
            if (binding) {
                const refused = refusedByBinding(binding, slots, new Set(reasons.keys()));
                if (refused) return ok(refused);
            }

            // The local slots and the adaptable names come from the binding the host composed at dispatch, else from
            // the contract itself. Without them no free-text value can be told from a fact of the machine, and an
            // unknown name could carry one, thus no render happens without them.
            let locals: readonly TemplateParameter[];
            let adaptable: readonly string[];
            if (binding) {
                locals = binding.local;
                adaptable = binding.adaptable;
            } else {
                const contract = await deps.source.contract(deps.template);
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
            const remote: Record<string, unknown> = { ...boundSplit.remote, ...split.remote };
            // A bound local slot is bound on the machine like a model value, under the model value.
            const localValues: Record<string, unknown> = { ...boundSplit.local, ...split.local };
            const localByName = new Map(locals.map((parameter) => [parameter.name, parameter]));
            // A local value the contract refuses is refused before the render, thus a bad path costs no render.
            const localIssues = Object.entries(localValues).flatMap(([name, value]) => {
                const issue = validateLocalSlot(presentGet(localByName, name, "the template parameter of the local value"), value);
                return issue ? [describedIssue(issue, localByName)] : [];
            });
            if (localIssues.length > 0) {
                return ok({ match: "rejected", message: "one or more local slot values are not valid for this template", issues: localIssues });
            }

            const farmLockFile = typeof deps.farmLockFile === "function" ? deps.farmLockFile(ctx.session.scope.analysisId) : deps.farmLockFile;
            const installed = installedPackages({ farmLockFile, imagePackagesFile: deps.imagePackagesFile });
            const answer = await deps.source.render(deps.template, remote, installed.packages, {
                step: binding?.step,
                claims: binding?.claims,
                expectedSnapshot: binding?.snapshot,
            });
            // A rendered answer carries `ok: true`; the refusals carry `match` and no `ok`.
            if (!("ok" in answer)) return ok(answer);

            const bound = bindLocalSlots({ language: answer.template.language, parameters: locals }, answer.script, localValues, answer.slots);
            if (!bound.ok) {
                return ok({
                    match: "rejected",
                    message: "one or more local slot values are not valid for this template",
                    issues: bound.issues.map((issue) => describedIssue(issue, localByName)),
                });
            }

            // The settings that the script reads: the entries of the source, with each local marker entry replaced by
            // the slot as bound here. A slot whose condition fails is in the script with a value that nothing reads.
            const boundByName = new Map(bound.slots.map((slot) => [slot.name, slot]));
            const settings = answer.slots.flatMap((slot): TemplateRender["settings"] => {
                const entry = slot.source === "local" ? boundByName.get(slot.name) : slot;
                if (entry === undefined || entry.read === false) return [];
                // The source names each value of the request `caller`, thus a value that the plan binds is a plan setting here.
                const bound = binding?.slots[entry.name];
                const fromPlan = bound !== undefined && !reasons.has(entry.name) && sameValue(bound, entry.value);
                return [{ name: entry.name, value: settingValue(entry.value), source: fromPlan ? "plan" : entry.source, lines: [...entry.lines] }];
            });
            const render: TemplateRender = {
                template: `${answer.template.id}@${answer.template.version}`,
                label: answer.template.label,
                method: { id: answer.template.method.id, label: answer.template.method.label },
                snapshot: answer.snapshot.digest,
                settings,
                overrides: [...reasons].map(([slot, reason]) => ({ slot, reason })),
                environmentMatch: answer.environment.match,
            };

            const language = answer.template.language === "R" ? "R" : "py";
            const written = await deps.mutator.writeFile({
                path: script_path ?? `${answer.template.id}.${language}`,
                content: bound.script,
                toolName: RUN_TEMPLATE_TOOL_ID,
                invocationId: ctx.invocationId,
                session: ctx.session,
                template: render,
            });
            if (written.status !== "ok") {
                return ok({ status: "write_refused", path: written.path, reason: written.status === "read_only" ? written.reason : written.status });
            }

            const runDir = cwd === undefined ? deps.workingDir : cwd.startsWith("/") ? cwd : posixPath.join(deps.workingDir, cwd);
            const command = [language === "R" ? "Rscript" : "python3", written.path];
            const ran = await runSandboxExec({ lease: deps.lease, command, cwd: runDir, timeoutSeconds, emit: ctx.emit, invocationId: ctx.invocationId });
            if (ran.isErr()) return err(ran.error);
            const result = ran.value;
            if (result.exitCode !== 0) logger.info("a template run ended with a non-zero exit code", { template: render.template, exitCode: result.exitCode });

            const execResult = boundExecResult(result);
            const note = execNote(execResult);
            const output: RunTemplateRan = {
                status: "ran",
                script_path: written.path,
                template: {
                    id: answer.template.id,
                    version: answer.template.version,
                    label: answer.template.label,
                    method: { id: answer.template.method.id, label: answer.template.method.label },
                    substitute_for:
                        answer.template.substitute_for === undefined
                            ? undefined
                            : { id: answer.template.substitute_for.id, label: answer.template.substitute_for.label },
                },
                environment_match: answer.environment.match,
                expected_outputs: answer.outputs,
                ...execResult,
                note,
            };
            const record: RunTemplateCallRecord = {
                write: written.record,
                command,
                scriptPath: written.record.path,
                exitCode: result.exitCode,
                durationMs: result.durationMs,
                provenance: result.provenance,
            };
            return ok(withToolCallRecord(output, record));
        },
        foldCallRecord: (record) => {
            deps.mutator.recordWrite(record.write);
            if (!deps.lineageCollector || !deps.mountRoot) return;
            try {
                feedExecFrame({
                    collector: deps.lineageCollector,
                    mountRoot: deps.mountRoot,
                    command: record.command,
                    scriptPath: record.scriptPath,
                    exitCode: record.exitCode,
                    durationMs: record.durationMs,
                    logger: deps.logger,
                    provenance: record.provenance,
                });
            } catch (cause) {
                logger.warn("provenance frame handling failed (non-fatal)", logger.errorFields(cause));
            }
        },
    });
}
