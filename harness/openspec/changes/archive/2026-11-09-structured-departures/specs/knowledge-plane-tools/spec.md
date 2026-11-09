## MODIFIED Requirements

### Requirement: The plan step carries an optional grounding

`AnalysisStepSchema` and `PlanStepSchema` MUST carry an optional `grounding` object with `status` (`grounded`, `ungrounded`, `flagged`), `snapshot`, `claims`, an optional `template`, an optional `settings` list, and `reason`. The object MUST also carry an optional `departures` list. Each entry of `settings` MUST carry the procedure step, the name, the value, and an optional source. The value is a string, a number, a boolean, or a list of strings. The planner MUST copy `settings` from the skeleton step as it is. A plan without the field MUST validate as before. The briefing MUST render the field beside the task fields.

A departure states where a grounded step keeps its method and departs from a rule that it cites. Each entry of `departures` MUST carry the claim id of the rule and the reason. An entry MUST name the setting that it changes, unless it leaves out a part of the rule that no setting carries. An entry MUST carry the value of the plan, unless the plan does not apply the setting. The Grounding section of the briefing MUST render each departure with its rule, its setting, the value of the plan, and the reason.

The validation of the plan MUST refuse a departure in these conditions:

- its rule is not a claim of the grounding of the step
- its setting is not the name of a setting of the step
- it carries a value and no setting
- a second departure names the same setting.

A departure can name a rule id in place of a claim id. If exactly one claim of the step has that rule id, `submit_plan` MUST give the departure that claim id before the validation.

#### Scenario: A stored plan without grounding loads

- **GIVEN** a plan persisted before the field existed
- **WHEN** it is loaded and validated
- **THEN** validation passes

#### Scenario: A grounded step keeps its settings

- **GIVEN** a skeleton step whose grounding holds the alpha of the test with its step and source
- **WHEN** the planner submits the plan with the step copied as it is
- **THEN** the plan validates, and the stored step carries the setting with its step, name, value, and source

#### Scenario: A grounded step reaches its agent

- **GIVEN** a step with a grounding that names a template
- **WHEN** the briefing composes
- **THEN** the seed carries the status, the template, the snapshot, the claims, and the reason

#### Scenario: A departure names a rule id

- **GIVEN** a recommend answer that holds `R-0001@e7d0`
- **WHEN** the planner submits a step that cites `R-0001@e7d0` and departs from `R-0001` for the setting `lfc_shrink`
- **THEN** the stored departure names `R-0001@e7d0`

#### Scenario: A departure from a rule that the step does not cite

- **WHEN** the planner submits a step whose departure names `R-0010@2b3c`, and the step does not cite `R-0010@2b3c`
- **THEN** `submit_plan` refuses the plan, and the issue names the claims of the step

#### Scenario: A step with a departure reaches its agent

- **GIVEN** a step with a departure from `R-0001@e7d0` that gives `min_count = 5`
- **WHEN** the briefing composes
- **THEN** the Grounding section lists the departure with `R-0001@e7d0`, `min_count`, the value 5, and the reason

### Requirement: The plan settings bind to the render request

At dispatch the parent MUST intersect the `grounding.settings` of the step with the adaptable slots of the served contract, by name. Each setting that names an adaptable slot MUST become a bound slot of the `templateBinding` of the child input, with its source. The seed MUST list each bound setting under `Bound by the plan` with its value and its source. The seed MUST list each other setting under `Unbound settings` with its procedure step, its source when the setting has one, and the reason. A setting that names a pinned slot with a different value is a pinned conflict. A setting that names no slot stays a plan setting. A setting binds only when its value fits the slot. A fit is a member of the enum of the slot, a number for a number slot, or a boolean for a boolean slot. A free-text slot never binds, because a plan setting can be a policy word and not a value of the slot. A setting that does not fit its slot MUST be listed as unbound with the reason. `knowledge_template` MUST merge the bound slots under the model values. The tool MUST refuse a model value that differs from a bound value when no `overrides` entry names the slot with a reason. The refusal MUST come before the service call, and it MUST name the slot, the bound value, and its source. The decision record on disk MUST carry `bound_slots` and `settings_overrides`.

A departure of the plan changes a setting before the intersection. A setting that a departure names with a value MUST take the value of the departure, with the source `departure from <claim id>`. A setting that a departure names with no value MUST NOT bind. The seed MUST list that setting as unbound, with the claim id and the reason. The binding MUST carry the departures of the step, and the decision record MUST carry them as `departures`.

A template gives each slot a value, and an omitted slot takes the default of the template. Thus the binding MUST name an adaptable slot as excluded when a departure with no value names it. `knowledge_template` MUST refuse a render that sends no value for an excluded slot. It MUST also refuse a value with no override. The decision record MUST keep the override of an excluded slot with a `plan_value` of `null`.

#### Scenario: A policy word on an integer slot

- **GIVEN** a step whose settings hold `min_samples = smallest_group_size` and `min_count = 10`
- **WHEN** the seed composes against a contract whose two slots are integers
- **THEN** the binding holds `min_count = 10` and not `min_samples`, and the seed lists `min_samples` as unbound with the reason

#### Scenario: An unbound setting keeps its source

- **GIVEN** a step whose settings hold `alpha = 0.05` with the source `doi:10.1186/s13059-014-0550-8`, and a contract that pins `alpha` at 0.05
- **WHEN** the seed composes
- **THEN** the line of `alpha` under `Unbound settings` names the procedure step and the source

#### Scenario: A bound slot rides without a model value

- **GIVEN** a child input whose binding holds `lfc_shrink = apeglm` from the plan
- **WHEN** the agent calls `knowledge_template` with the template and the paths only
- **THEN** the render request carries `lfc_shrink = apeglm`, and the decision record lists it under `bound_slots` with its source

#### Scenario: A changed value without an override is refused

- **GIVEN** a child input whose binding holds `lfc_shrink = apeglm`
- **WHEN** the agent calls `knowledge_template` with `lfc_shrink = ashr` and no `overrides` entry
- **THEN** the tool answers `{ match: "rejected" }` before the service call, the issue names `lfc_shrink`, the value `apeglm`, and its source, and no file is written

#### Scenario: An override with a reason renders

- **GIVEN** a child input whose binding holds `lfc_shrink = apeglm`
- **WHEN** the agent calls `knowledge_template` with `lfc_shrink = ashr` and an `overrides` entry that names `lfc_shrink` with a reason
- **THEN** the script renders with `ashr`. The decision record lists the change under `settings_overrides` with the plan value, the new value, and the reason

#### Scenario: A departure changes a bound value

- **GIVEN** a step whose settings hold `min_count = 10`, and a departure from `R-0001@e7d0` that gives `min_count = 5`
- **WHEN** the seed composes against a contract whose `min_count` slot is an integer
- **THEN** the binding holds `min_count = 5` with the source `departure from R-0001@e7d0`
- **AND** the decision record of the render lists the departure

#### Scenario: A departure removes a setting

- **GIVEN** a step whose settings hold `lfc_shrink = apeglm`, and a departure from `R-0001@e7d0` for `lfc_shrink` with no value
- **WHEN** the seed composes
- **THEN** the binding holds no `lfc_shrink`, and the seed lists `lfc_shrink` as unbound with the claim id and the reason
- **AND** the binding names `lfc_shrink` as excluded

#### Scenario: A render of an excluded slot

- **GIVEN** a binding that names `lfc_shrink` as excluded
- **WHEN** the model renders with no `lfc_shrink`, or with `lfc_shrink` and no override
- **THEN** `knowledge_template` refuses the render
- **WHEN** the model renders with `lfc_shrink = none` and an override with the reason
- **THEN** the decision record keeps the override with a `plan_value` of `null`

### Requirement: The briefing gives the methods of each upstream step

At dispatch the parent MUST give the handoff of each completed dependency the methods of that dependency. The methods come from the grounding of its plan step, the claim views of the run input, and the host copies of its records. The read of the records MUST be the confined and bounded read of the methods of a step. The handoff MUST render the grounding and the snapshot digest, each template with its method, and the rules and the sources of the dependency. The handoff MUST also render the departures of the dependency. The rules, the departures, and the sources MUST each be bounded by `UPSTREAM_METHODS_MAX_ITEMS`, with a count of the tail. The handoff MUST also list the in-sandbox path of the copy in the step of each decision record, bounded by `MAX_UPSTREAM_DECISION_RECORDS`. A dependency with no grounding and no record MUST render as before.

#### Scenario: A report step after a grounded step

- **GIVEN** a step `T1S1` with a grounding that cites `R-0001@e7d0`, and a decision record of `tpl-deseq2-two-group@1.0.0` with one DOI
- **WHEN** the parent composes the seed of a step that depends on `T1S1`
- **THEN** the handoff of `T1S1` renders the grounding, the template with its method, the title of `R-0001@e7d0`, and the DOI
- **AND** the handoff lists the path of the decision record

#### Scenario: A dependency with no methods

- **WHEN** the parent composes the seed of a step whose dependency has no grounding and no decision record
- **THEN** the handoff of the dependency has no grounding line and no decision record line

#### Scenario: A dependency with a departure

- **GIVEN** a dependency whose grounding departs from `R-0028@d560` with `n_top_genes_pca = 364`
- **WHEN** the parent composes the seed of a step that depends on it
- **THEN** the handoff lists the departure with the rule, the setting, the value of the plan, and the reason
