/**
 * Simulate the ten design patterns of the task set and the template tests, one seed each, with
 * the MSigDB Hallmark sets planted when the reference store holds the GMT.
 *
 *   bun eval/src/simulate.ts [--seed 1] [--hallmark path.gmt]
 *
 * The runner and the template tests read `eval/data/<pattern>/seed-<n>/`.
 * The hallmark file also lands at `eval/data/refs/hallmark.gmt`, which the
 * template test runner mounts at `/work/refs`.
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { EVAL_ROOT } from "./tasks.js";

const PATTERNS = ["two_group_n3", "two_group_n6", "paired_n5", "batch_balanced_n6", "interaction_2x2_n4", "timecourse_2x4_n3", "confounded_batch_n6", "no_replicates_1v1", "multi_group_3x4", "outlier_n5"];

function argument(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

const seed = argument("--seed") ?? "1";
const hallmark = argument("--hallmark") ?? join(homedir(), ".local", "share", "inflexa", "refs", "managed", "msigdb-hallmark-human", "2026.1", "h.all.v2026.1.Hs.symbols.gmt");
const hallmarkPresent = await Bun.file(hallmark).exists();
if (hallmarkPresent) {
    await mkdir(join(EVAL_ROOT, "data", "refs"), { recursive: true });
    await Bun.write(join(EVAL_ROOT, "data", "refs", "hallmark.gmt"), Bun.file(hallmark));
} else {
    console.log(`no hallmark GMT at ${hallmark}; the datasets carry synthetic gene names only`);
}

for (const pattern of PATTERNS) {
    const out = join(EVAL_ROOT, "data", pattern, `seed-${seed}`);
    const proc = Bun.spawn(["Rscript", join(EVAL_ROOT, "src", "simulate.R"), "--pattern", pattern, "--seed", seed, "--out", out, ...(hallmarkPresent ? ["--hallmark", hallmark] : [])], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) {
        console.error(`✗ ${pattern}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`);
        process.exit(1);
    }
    console.log(stderr.trim().split("\n").at(-1));
}
