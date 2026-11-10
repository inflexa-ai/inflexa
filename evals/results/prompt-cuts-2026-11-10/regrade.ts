// Re-grade the failed trials of reports with the current graders, from the files that their recorded calls wrote.
// A passing trial keeps no calls, thus it keeps its grade; a widened grader turns only failures into passes.
import { readFileSync, writeFileSync } from "node:fs";
import { allCases as domainCases } from "../../cases/index.ts";
import type { Trial } from "../../lib/case.ts";

type Call = { tool: string; input: Record<string, unknown>; step: number; refused: boolean };
const workingRel = (path: string): string => path.replace(/^\/analysis-001\/runs\/run-001\/T1S\d\//, "");

function filesOf(calls: readonly Call[]): Record<string, string> {
    const files: Record<string, string> = {};
    for (const call of calls) {
        if (call.input === undefined || call.input === null) continue;
        const path = typeof call.input["path"] === "string" ? workingRel(call.input["path"]) : undefined;
        if (path === undefined) continue;
        if (call.tool === "write_file" && typeof call.input["content"] === "string") files[path] = call.input["content"];
        if (call.tool === "edit_file" && files[path] !== undefined) {
            const edits = Array.isArray(call.input["edits"]) ? call.input["edits"] : [call.input];
            for (const edit of edits as Record<string, unknown>[]) {
                const from = edit["old_string"] ?? edit["oldString"] ?? edit["old_str"];
                const to = edit["new_string"] ?? edit["newString"] ?? edit["new_str"];
                if (typeof from === "string" && typeof to === "string") files[path] = files[path].replace(from, to);
            }
        }
    }
    return files;
}

for (const path of process.argv.slice(2)) {
    const report = JSON.parse(readFileSync(path, "utf8"));
    let passes = 0, total = 0, flipped = 0, errors = 0;
    const perCase: string[] = [];
    for (const c of report.cases) {
        const evalCase = domainCases.find((d) => d.id === c.id);
        let p = 0;
        for (const t of c.results) {
            if (t.kind === "error") { errors++; continue; }
            total++;
            if (t.pass) { p++; continue; }
            if (evalCase === undefined) continue;
            const trial: Trial = { calls: t.calls ?? [], asks: [], text: t.text ?? "", finishReason: "stop", stepFinishes: [], capped: t.capped ?? false, files: filesOf(t.calls ?? []) };
            const g = evalCase.grade(trial);
            if (g.pass) { p++; flipped++; t.pass = true; t.detail = `regraded: ${g.detail}`; }
        }
        passes += p;
        c.passes = p;
        c.rate = p / c.results.filter((t: { kind: string }) => t.kind !== "error").length;
        perCase.push(`${c.id}\t${p}/${c.results.filter((t: { kind: string }) => t.kind !== "error").length}`);
    }
    console.log(`${path}: ${passes}/${total} after re-grade (${flipped} flipped), ${errors} errors`);
    if (process.env["DETAIL"] === "1") console.log(perCase.join("\n"));
    writeFileSync(path.replace(/\.json$/, ".regraded.json"), JSON.stringify(report, null, 2));
}
