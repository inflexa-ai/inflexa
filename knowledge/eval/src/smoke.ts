/**
 * The end-to-end smoke of the boundary: the HTTP client of the harness against
 * the running service, on the eight evaluation tasks. It prints the central
 * method, the flags, the template, and the claim count per task, runs one
 * check and one render, and exits non-zero when any answer is unavailable.
 *
 *   bun eval/src/smoke.ts [--service-url http://127.0.0.1:8790] [--service-key-env INFLEXA_KNOWLEDGE_SERVICE_KEY]
 */

import { createHttpKnowledgeClient, type KnowledgeSituation } from "@inflexa-ai/harness";

import { loadTasks } from "./tasks.js";

function argument(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

/** The situation a careful planner extracts from each task profile. */
function situationOf(pattern: string): KnowledgeSituation {
    const base: KnowledgeSituation = {
        question: "full_plan",
        modality: "bulk_rna_seq",
        data_state: "counts",
        count_source: "salmon",
        organism: "human",
        n_groups: 2,
        n_per_group_min: 6,
        n_per_group_max: 6,
        paired: false,
        batch: "none",
    };
    switch (pattern) {
        case "two_group_n3":
            return { ...base, n_per_group_min: 3, n_per_group_max: 3 };
        case "two_group_n6":
            return { ...base, quality_flags: ["low_depth_sample"] };
        case "paired_n5":
            return { ...base, paired: true, blocking_factor: "subject", n_per_group_min: 5, n_per_group_max: 5, count_source: "star_featurecounts" };
        case "batch_balanced_n6":
            return { ...base, batch: "known_balanced" };
        case "interaction_2x2_n4":
            return { ...base, interaction: true, n_groups: 4, n_per_group_min: 4, n_per_group_max: 4 };
        case "timecourse_2x4_n3":
            return { ...base, n_timepoints: 4, n_per_group_min: 3, n_per_group_max: 3 };
        case "confounded_batch_n6":
            return { ...base, batch: "known_confounded" };
        case "no_replicates_1v1":
            return { ...base, n_per_group_min: 1, n_per_group_max: 1 };
        default:
            return base;
    }
}

const serviceUrl = argument("--service-url") ?? "http://127.0.0.1:8790";
const serviceKey = Bun.env[argument("--service-key-env") ?? "INFLEXA_KNOWLEDGE_SERVICE_KEY"] ?? "";
const client = createHttpKnowledgeClient({ baseUrl: serviceUrl, apiKey: serviceKey });
let failures = 0;

for (const task of await loadTasks()) {
    const answer = await client.recommend(situationOf(task.pattern));
    if (answer.match === "unavailable" || answer.match === "rejected") {
        failures += 1;
        console.log(`✗ ${task.id}: ${answer.match} ${"reason" in answer ? answer.reason : answer.message}`);
        continue;
    }
    const de = answer.procedure.find((step) => step.step === "differential_expression");
    const flags = answer.flags.map((flag) => `${flag.rule}:${flag.outcome ?? flag.severity}`).join(",");
    console.log(`✓ ${task.id}: match=${answer.match} de=${de?.method?.label ?? "(none)"} template=${de?.template ?? "-"} claims=${answer.claims.length} flags=[${flags}] snapshot=${answer.snapshot.digest.slice(0, 19)}`);
}

const check = await client.check(situationOf("two_group_n6"), [
    { step_type: "differential_expression", method: "DESeq2 Wald test", package: "DESeq2", parameters: [{ name: "alpha", value: 0.1 }] },
]);
console.log(`check: ${"ok" in check ? `${check.violations.length} violation(s), ${check.warnings.length} warning(s)` : check.match}`);
if (!("ok" in check)) failures += 1;

const render = await client.render("tpl-deseq2-two-group@1.0.0", {
    counts_path: "/analysis/data/inputs/counts/counts.csv",
    metadata_path: "/analysis/data/inputs/metadata/metadata.csv",
    condition_column: "condition",
    reference_level: "control",
    test_level: "treated",
}, [{ name: "DESeq2", version: "1.52.0" }]);
if ("ok" in render) console.log(`render: ${render.script.split("\n").length} lines, environment ${render.environment.match}, syntax ${render.syntax.status}, ${render.slots.length} slots`);
else {
    failures += 1;
    console.log(`render: ${render.match} ${"reason" in render ? render.reason : render.message}`);
}
process.exit(failures > 0 ? 1 : 0);
