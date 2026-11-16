import type { JSX } from "solid-js";

import { GLYPHS } from "../../../lib/design_system.ts";
import type { PlanCardDepartureView, PlanCardGroundingView, PlanCardStepView } from "../../../types/session.ts";
import { ResultsDialog } from "./results_dialog.tsx";

/** The most rules and sources that the grounding section lists. A count names the rest. */
export const MAX_GROUNDING_ITEMS = 20;

function section(lines: string[], title: string, values: readonly string[]): void {
    lines.push("", `${title}:`);
    if (values.length === 0) lines.push(`  ${GLYPHS.emDash}`);
    else for (const value of values) lines.push(`  - ${value}`);
}

/** The first {@link MAX_GROUNDING_ITEMS} values, and a count of the rest. */
function bounded(values: readonly string[]): string[] {
    if (values.length <= MAX_GROUNDING_ITEMS) return [...values];
    return [...values.slice(0, MAX_GROUNDING_ITEMS), `(+${values.length - MAX_GROUNDING_ITEMS} more)`];
}

/** The text of one departure: the rule, then the setting with the value of the plan, or the setting that the plan does not apply, then the reason. */
function departureText(departure: PlanCardDepartureView): string {
    switch (departure.change) {
        case "value":
            return `${departure.rule}: ${departure.setting} = ${departure.value}. ${departure.reason}`;
        case "not_applied":
            return `${departure.rule}: ${departure.setting} not applied. ${departure.reason}`;
        case "left_out":
            return `${departure.rule}: ${departure.reason}`;
        default: {
            const unhandled: never = departure.change;
            throw new Error(`unhandled departure change: ${String(unhandled)}`);
        }
    }
}

/** The grounding of the step: the release, the template, the reason, the rules, the settings, the departures, and the sources. */
function groundingSection(lines: string[], grounding: PlanCardGroundingView): void {
    lines.push(
        "",
        `grounding: ${grounding.status} ${GLYPHS.middot} knowledge release ${grounding.snapshot}`,
        `template: ${grounding.template || GLYPHS.emDash}`,
    );
    lines.push("", "reason:", `  ${grounding.reason || GLYPHS.emDash}`);
    const rules = grounding.rules.map((rule) => (rule.title ? `${rule.id} (${rule.strength}) ${rule.title}` : rule.id));
    section(lines, "rules", bounded(rules));
    const settings = grounding.settings.map((setting) => {
        const value = `${setting.step}.${setting.name} = ${setting.value}`;
        return setting.source ? `${value} (${setting.source})` : value;
    });
    section(lines, "settings", settings);
    if (grounding.departures.length > 0) section(lines, "departures from the rules", grounding.departures.map(departureText));
    const sources = grounding.sources.map((source) => {
        const cited = `${source.title} (${source.year})`;
        return source.ref ? `${cited}, ${source.ref}` : cited;
    });
    section(lines, "sources", bounded(sources));
}

/** Compose the copied primitive step fields into the read-only detail dialog's rows. */
export function planStepDetailLines(step: PlanCardStepView): string[] {
    const dependsOn = step.depends_on.length > 0 ? step.depends_on.join(", ") : GLYPHS.emDash;
    const lines = [
        `agent: ${step.agent || GLYPHS.emDash}`,
        `track: ${step.track || GLYPHS.emDash}`,
        `type: ${step.step_type || GLYPHS.emDash}`,
        `depends on: ${dependsOn}`,
        "",
        "question:",
        `  ${step.question || GLYPHS.emDash}`,
    ];
    section(lines, "acceptance criteria", step.acceptance_criteria);
    section(lines, "constraints", step.constraints);
    section(lines, "caveats", step.caveats);
    if (step.grounding !== undefined) groundingSection(lines, step.grounding);
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
