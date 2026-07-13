import type { JSX } from "solid-js";

import { GLYPHS } from "../../../lib/design_system.ts";
import type { PlanCardStepView } from "../../../types/session.ts";
import { ResultsDialog } from "./results_dialog.tsx";

function section(lines: string[], title: string, values: readonly string[]): void {
    lines.push("", `${title}:`);
    if (values.length === 0) lines.push(`  ${GLYPHS.emDash}`);
    else for (const value of values) lines.push(`  - ${value}`);
}

/** Compose the copied primitive step fields into the read-only detail dialog's rows. */
export function planStepDetailLines(step: PlanCardStepView): string[] {
    const dependsOn = step.depends_on.length > 0 ? step.depends_on.join(", ") : GLYPHS.emDash;
    const resources = step.resources
        ? `${step.resources.cpu} CPU ${GLYPHS.middot} ${step.resources.memoryGb} GB memory ${GLYPHS.middot} ${step.resources.gpuCount} GPU`
        : GLYPHS.emDash;
    const lines = [
        `agent: ${step.agent || GLYPHS.emDash}`,
        `track: ${step.track || GLYPHS.emDash}`,
        `type: ${step.step_type || GLYPHS.emDash}`,
        `depends on: ${dependsOn}`,
        `resources: ${resources}`,
        "",
        "question:",
        `  ${step.question || GLYPHS.emDash}`,
    ];
    section(lines, "acceptance criteria", step.acceptance_criteria);
    section(lines, "constraints", step.constraints);
    section(lines, "caveats", step.caveats);
    return lines;
}

/** Read-only detail for one step selected from the latest plan card. */
export function PlanStepDetailDialog(props: { step: PlanCardStepView; onClose: () => void }): JSX.Element {
    return (
        <ResultsDialog
            title={`${props.step.id} ${GLYPHS.middot} ${props.step.name}`}
            lines={planStepDetailLines(props.step)}
            emptyText="No step details"
            onClose={props.onClose}
        />
    );
}
