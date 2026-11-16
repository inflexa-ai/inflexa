/**
 * The binding of the plan settings of a template step to the contract of its template. The host reads the contract
 * at dispatch, projects it for the seed, and binds each plan setting to a slot, a pinned value, the script, or an
 * unbound line. `run_template` takes the binding from the durable step input.
 */

import type { TemplateBoundSetting, TemplateBrief } from "../../prompts/briefing.js";
import type { AnalysisStep, GroundingDeparture, GroundingSetting } from "../../schemas/workflow-state.js";
import type { KnowledgeRejected, KnowledgeUnavailable, TemplateContract, TemplateParameter, TemplateSource } from "./client.js";
import type { TemplateBinding, TemplateBindingValue } from "./run-template.js";

/** The template part of the seed of a template step: the brief or the reason for its absence, and the binding when one holds. */
export type TemplateSeedPart = {
    readonly briefing: { readonly template?: TemplateBrief; readonly templateNotRetrieved?: string };
    readonly binding?: TemplateBinding;
};

/** A served contract carries no `match`; the two refusals do. */
function isTemplateContract(answer: TemplateContract | KnowledgeUnavailable | KnowledgeRejected): answer is TemplateContract {
    return !("match" in answer);
}

/**
 * Fetch the contract of the template of a template step, and bind the plan
 * settings to it. A step without a template has no template part. A step
 * with one and no way to read it (no source, no answer, or an unknown
 * template) gets the reason, thus the seed reports the absence rather than
 * hiding it, and no binding.
 */
export async function resolveTemplateContract(step: AnalysisStep, source: TemplateSource | undefined): Promise<TemplateSeedPart> {
    const ref = step.grounding?.template;
    if (!ref) return { briefing: {} };
    if (!source) return { briefing: { templateNotRetrieved: "no template source is bound" } };

    const answer = await source.contract(ref);
    if (!isTemplateContract(answer)) {
        const reason =
            answer.match === "unavailable"
                ? `the knowledge service did not answer: ${answer.reason}`
                : `the knowledge service refused the lookup: ${answer.message}`;
        return { briefing: { templateNotRetrieved: reason } };
    }
    return bindTemplateContract(ref, answer, step.grounding?.settings ?? [], {
        stepId: step.id,
        claims: step.grounding?.claims ?? [],
        snapshot: step.grounding?.snapshot && step.grounding.snapshot !== "none" ? step.grounding.snapshot : undefined,
        departures: step.grounding?.departures ?? [],
    });
}

/** The version of a template reference (`tpl-x@1.0.0` gives `1.0.0`), or `undefined` when the reference has none. */
function versionOfRef(ref: string): string | undefined {
    const at = ref.indexOf("@");
    return at < 0 ? undefined : ref.slice(at + 1);
}

/** Two setting values agree when their JSON agrees: the values are scalars or lists of strings. */
function sameSettingValue(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/** A list with each member as text. The skeleton keeps the members of a list setting as text, and the contract keeps their types. */
function listAsText(value: unknown): unknown {
    return Array.isArray(value) ? value.map(String) : value;
}

/**
 * Whether a plan value is a value of the slot, and not a policy word. A
 * procedure parameter and a template slot share a name, but not always a
 * value domain: `min_samples = smallest_group_size` names a rule the agent
 * applies, and the slot takes the resulting integer. Only a member of the
 * enum of the slot, a number for a number slot, or a boolean for a boolean
 * slot binds. A free-text slot never binds, because the host cannot tell a
 * policy word from a value there.
 */
function fitsSlot(slot: TemplateParameter, value: unknown): boolean {
    if (slot.enum) return typeof value === "string" && slot.enum.includes(value);
    if (slot.type === "integer" || slot.type === "number") return typeof value === "number";
    if (slot.type === "boolean") return typeof value === "boolean";
    return false;
}

/** What binds the render to the plan step beside the settings: its id, its claims, the release the plan pinned, and its departures. */
export type StepGroundingRef = {
    readonly stepId: string;
    readonly claims: readonly string[];
    readonly snapshot?: string;
    readonly departures: readonly GroundingDeparture[];
};

/**
 * Project the served contract for the seed, and intersect the plan settings
 * with its slots by name. Each setting lands in exactly one place:
 *
 * - a setting that names an adaptable slot is bound (the first value wins
 *   when two procedure steps set the same slot; a later different value is
 *   reported, not bound)
 * - a setting that names a pinned slot cannot be sent: a different value is
 *   a pinned conflict the agent must know about, an equal value is satisfied
 * - a setting that names no slot stays a plan setting the agent applies itself
 *
 * A departure of the plan replaces the value of its setting before the
 * intersection, thus the value of the plan takes each path above in place of
 * the value of the rule. A departure that names a setting and gives no value
 * removes the setting: the plan does not apply it, and nothing binds it. When
 * that setting names an adaptable slot, the binding names the slot as excluded,
 * and the render must send its value with an override.
 *
 * A served version that differs from the version the plan names binds
 * nothing: the render refuses the plan version, and the settings then ride
 * as unbound lines under the caveat the section renders.
 */
export function bindTemplateContract(
    ref: string,
    contract: TemplateContract,
    settings: readonly GroundingSetting[],
    grounding: StepGroundingRef,
): TemplateSeedPart {
    const refVersion = versionOfRef(ref);
    const versionMatches = refVersion === undefined || refVersion === contract.version;
    const adaptable = contract.parameters.filter((slot) => slot.adaptable);
    const adaptableNames = new Set(adaptable.map((slot) => slot.name));
    const pinnedByName = new Map(contract.parameters.filter((slot) => !slot.adaptable).map((slot) => [slot.name, slot]));

    const bound: TemplateBoundSetting[] = [];
    const unbound: string[] = [];
    const doneByScript: string[] = [];
    const slots: Record<string, TemplateBindingValue> = {};
    const sources: Record<string, string> = {};
    const excluded: string[] = [];
    // The settings that the script does with no slot, by name. A name that is also a slot is not such a setting:
    // the slot carries it. The service gives one entry for one setting, and the first entry is the entry.
    const byConstruction = new Map<string, unknown>();
    for (const entry of contract.settings_by_construction ?? []) {
        if (!byConstruction.has(entry.setting) && !adaptableNames.has(entry.setting) && !pinnedByName.has(entry.setting))
            byConstruction.set(entry.setting, entry.value);
    }

    const departureBySetting = new Map(
        grounding.departures.flatMap((departure) => (departure.setting === undefined ? [] : [[departure.setting, departure] as const])),
    );

    for (const rule of settings) {
        const departure = departureBySetting.get(rule.name);
        if (departure !== undefined && departure.value === undefined) {
            const departs = `\`${rule.name}\` = ${JSON.stringify(rule.value)} (${rule.step}${rule.source ? `; ${rule.source}` : ""}): the plan departs from ${departure.rule} and does not apply it (${departure.reason})`;
            // A slot of the template always takes a value, and an omitted slot takes the default of the template. Thus the
            // render must send the value that matches the plan, and the render facts keep it as an override.
            if (versionMatches && adaptableNames.has(rule.name)) {
                excluded.push(rule.name);
                unbound.push(
                    `${departs}, but the template gives each slot a value; send the value that matches the plan, with an \`overrides\` entry and the reason`,
                );
            } else if (pinnedByName.has(rule.name)) {
                unbound.push(`${departs}, but the template pins \`${rule.name}\``);
            } else if (versionMatches && byConstruction.has(rule.name)) {
                // The script has no slot for it, thus the plan cannot remove it from the script.
                unbound.push(
                    `${departs}, but the script of the template does \`${rule.name}\` = ${JSON.stringify(byConstruction.get(rule.name))} with no slot`,
                );
            } else {
                unbound.push(departs);
            }
            continue;
        }
        const setting: GroundingSetting =
            departure?.value === undefined ? rule : { ...rule, value: departure.value, source: `departure from ${departure.rule}` };
        const where = departure === undefined ? setting.source : `departure from ${departure.rule}: ${departure.reason}`;
        const shown = `\`${setting.name}\` = ${JSON.stringify(setting.value)} (${setting.step}${where ? `; ${where}` : ""})`;
        if (!versionMatches) {
            unbound.push(`${shown}: not bound, because the served version differs from the plan`);
            continue;
        }
        // A policy word is no value of a slot. The template can map the word to a slot value, and the map reads
        // the setting after its departure: a departure that changes the word or removes it also changes the bind.
        // The service refuses a template with two entries for one setting with one value, thus the first entry is the entry.
        const mapped = (contract.setting_bindings ?? []).find(
            (entry) => entry.setting === setting.name && sameSettingValue(listAsText(entry.value), listAsText(setting.value)),
        );
        const mappedSlot = mapped === undefined ? undefined : adaptable.find((candidate) => candidate.name === mapped.slot && candidate.local !== true);
        if (mapped !== undefined && (mappedSlot === undefined || !fitsSlot(mappedSlot, mapped.slot_value))) {
            unbound.push(
                `${shown}: the template maps it to \`${mapped.slot}\` = ${JSON.stringify(mapped.slot_value)}, which the served contract does not take`,
            );
            continue;
        }
        const target =
            mapped !== undefined && mappedSlot !== undefined
                ? {
                      slot: mappedSlot,
                      value: mapped.slot_value,
                      source: `the plan setting \`${setting.name}\`${where ? `; ${where}` : ""}`,
                  }
                : adaptableNames.has(setting.name)
                  ? { slot: adaptable.find((candidate) => candidate.name === setting.name), value: setting.value, source: setting.source ?? "plan" }
                  : undefined;
        if (target !== undefined) {
            const name = target.slot?.name ?? setting.name;
            if (target.slot && !fitsSlot(target.slot, target.value)) {
                unbound.push(`${shown}: a policy of the plan, not a value of the \`${name}\` slot (${target.slot.type}); state the value it gives`);
                continue;
            }
            const prior = slots[name];
            if (prior !== undefined) {
                if (!sameSettingValue(prior, target.value)) unbound.push(`${shown}: differs from the bound value ${JSON.stringify(prior)} of the same slot`);
                continue;
            }
            slots[name] = target.value;
            if (mapped !== undefined) sources[name] = target.source;
            else if (setting.source) sources[name] = setting.source;
            bound.push({ name, value: target.value, source: target.source });
            continue;
        }
        const pinned = pinnedByName.get(setting.name);
        if (pinned) {
            const pinnedValue = pinned.default === undefined ? "a fixed value" : JSON.stringify(pinned.default);
            // The script reads the pinned value, thus a plan setting with that value needs no act of the agent.
            if (sameSettingValue(pinned.default, setting.value)) doneByScript.push(`${shown}: pinned by the template at the same value`);
            else unbound.push(`${shown}: the template pins \`${setting.name}\` at ${pinnedValue}, and the plan value cannot be sent`);
            continue;
        }
        // The script does some settings with no slot. The plan value that the script does needs no bind and no
        // act of the agent. A different plan value is a conflict: no slot can send it.
        if (byConstruction.has(setting.name)) {
            const done = byConstruction.get(setting.name);
            if (sameSettingValue(listAsText(done), listAsText(setting.value))) doneByScript.push(shown);
            else
                unbound.push(
                    `${shown}: the script of the template does \`${setting.name}\` = ${JSON.stringify(done)} with no slot, and the plan value cannot be sent`,
                );
            continue;
        }
        unbound.push(`${shown}: no slot of the template carries it`);
    }

    return {
        briefing: {
            template: {
                ref,
                version_served: contract.version,
                slots: adaptable,
                inputs: (contract.inputs ?? []).map((input) => ({
                    name: input.name,
                    path: input.path,
                    description: input.description,
                })),
                bound,
                done_by_script: doneByScript,
                unbound_settings: unbound,
                notes: contract.notes?.trim() || undefined,
            },
        },
        binding: versionMatches
            ? {
                  template: ref,
                  slots,
                  sources,
                  step: grounding.stepId,
                  claims: grounding.claims,
                  snapshot: grounding.snapshot,
                  // The local slots of the contract, thus the tool binds a path or a column name on the machine
                  // without a second read of the contract.
                  local: contract.parameters.filter((slot) => slot.local === true),
                  adaptable: adaptable.map((slot) => slot.name),
                  departures: grounding.departures.length > 0 ? grounding.departures : undefined,
                  excluded: excluded.length > 0 ? excluded : undefined,
              }
            : undefined,
    };
}
