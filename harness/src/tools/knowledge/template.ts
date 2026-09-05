/**
 * `knowledge_template` — the model emits slot values, and the tool writes the
 * rendered script and the decision record into the step workspace through
 * the same mutator seam as `write_file`. The script is never output tokens.
 *
 * The farm versions ride from the tool, not from the model: the tool reads
 * the `inflexa.lock` of the farm when the host names one, and the service
 * answers with the environment match, which the decision record keeps.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { readFarmLockFile } from "../../sandbox/farm.js";
import { defineTool, type ToolError } from "../define-tool.js";
import type { WorkspaceMutator, WriteFileResult } from "../workspace/mutator.js";
import type { FarmPackage, KnowledgeClient, KnowledgeRejected, KnowledgeUnavailable } from "./client.js";

export interface KnowledgeTemplateDeps {
    readonly client: KnowledgeClient;
    readonly mutator: WorkspaceMutator;
    /** Host path of the farm `inflexa.lock`. Absent, the environment match reads as unknown. */
    readonly farmLockFile?: string;
}

/** The path of the decision record inside the step. The existing write-file provenance hashes it. */
export const DECISION_RECORD_PATH = "output/decision_record.json";

export type KnowledgeTemplateOutput =
    | {
          readonly status: "ok";
          readonly script_path: string;
          readonly decision_record_path: string;
          readonly template: { readonly id: string; readonly version: string; readonly label: string; readonly method: string };
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

export function createKnowledgeTemplateTool(deps: KnowledgeTemplateDeps) {
    return defineTool({
        id: "knowledge_template",
        // The mutator wraps the disk mutation in `ctx.runStep` itself, the same as
        // `write_file`, thus the body runs unwrapped in the workflow body.
        executionMode: "workflow",
        description:
            "Render a tested analysis script from a knowledge template and write it into your working directory. " +
            "Use it for a step whose briefing names a template in its Grounding (for example `tpl-deseq2-two-group@1.0.0`). " +
            "Send the template id and the slot values only: the file paths of your inputs (absolute `/<analysisId>/...` paths), the column names, the levels of the contrast, and the design. " +
            "Do not write the script yourself. The tool writes `scripts/<template>.R` or `scripts/<template>.py` and `output/decision_record.json` (the template, the snapshot, each slot with its source, the environment match, and the citations), then you run the script with `execute_command` using the command in `run_with`. " +
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
            script_name: z
                .string()
                .regex(/^[A-Za-z0-9_.-]+$/)
                .optional()
                .describe("The file name under `scripts/`. Defaults to `<template id>.R` or `<template id>.py` by the language of the template."),
        }),
        describeCall: ({ template }) => template,
        describeResult: (_input, result: KnowledgeTemplateOutput) =>
            "status" in result ? (result.status === "ok" ? `${result.script_path} (${result.environment_match})` : result.status) : result.match,
        execute: async ({ template, slots, script_name }, ctx): Promise<Result<KnowledgeTemplateOutput, ToolError>> => {
            const answer = await deps.client.render(template, slots, farmPackages(deps.farmLockFile));
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
            const record = { ...answer.decision_record, script_path: scriptWrite.path };
            const recordWrite = await write(DECISION_RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`);
            if (recordWrite.status !== "ok") return ok({ status: "write_refused", path: recordWrite.path, reason: recordWrite.status });

            return ok({
                status: "ok",
                script_path: scriptWrite.path,
                decision_record_path: recordWrite.path,
                template: { id: answer.template.id, version: answer.template.version, label: answer.template.label, method: answer.template.method },
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
