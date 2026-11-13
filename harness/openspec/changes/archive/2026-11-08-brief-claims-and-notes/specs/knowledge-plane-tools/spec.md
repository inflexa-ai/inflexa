## ADDED Requirements

### Requirement: The briefing names each cited claim by its title

The run input MUST carry the claim views of the stored plan. At dispatch the parent MUST give the briefing of a step the views whose claim id and snapshot digest match the grounding of the step. The Grounding section MUST render each claim of the step with its strength and its title. When a view has no title, the section MUST render the statement. The section MUST clamp the text to `CLAIM_TITLE_MAX_CHARS`. A claim with no view MUST render as its id. When no claim of the step has a view, the section MUST render the claim ids on one line. A run input without the field MUST compose as before.

#### Scenario: A step cites a claim with a view

- **GIVEN** a plan that keeps the view of `R-0001@e7d0` at the digest of the step
- **AND** the plan keeps a view of the same id at another digest, and a view of a claim of another step
- **WHEN** the parent composes the seed of the step
- **THEN** the Grounding section renders `R-0001@e7d0` with its strength and the title of the matched view
- **AND** the seed carries neither the view of the other digest nor the view of the other step

#### Scenario: A plan with no view

- **GIVEN** a plan that keeps no claim view
- **WHEN** the parent composes the seed of a step with claims
- **THEN** the Grounding section renders the claim ids on one line

## MODIFIED Requirements

### Requirement: The step briefing carries the template contract

When a plan step grounds on a template and the composition binds a knowledge client, the parent workflow MUST read the contract at dispatch. The read MUST use `contract(template)`, inside the checkpointed step that composes the seed. The child MUST NOT fetch the contract. The seed MUST carry a `Template contract` section with the adaptable slots of the contract only. For each slot the section MUST give the name, the type, the permitted values, and the pattern. It MUST give the default with its source, or the required state. The section MUST list the inputs of the template. When the contract carries notes, the section MUST render them, clamped to `TEMPLATE_NOTES_MAX_CHARS`. The section MUST NOT list a pinned slot. The section MUST render at most `MAX_TEMPLATE_SLOTS` slots, and it MUST clamp each description. The contract can be absent: no client is bound, the service does not answer, or the service does not hold the template. Then the Grounding section MUST carry one line `Template contract: not retrieved (<reason>)`. In that case the seed MUST carry no `Template contract` section, and the child input MUST carry no binding.

#### Scenario: A grounded step with a bound client

- **GIVEN** a plan step whose grounding names `tpl-deseq2-two-group@1.0.0` and a composition that binds a knowledge client
- **WHEN** the parent composes the seed of the step
- **THEN** the seed lists each adaptable slot with its type, its permitted values, and its pattern. Each slot shows its default with the source, or its required state. The seed lists the inputs and no pinned slot

#### Scenario: The contract carries notes

- **GIVEN** a served contract whose notes say that the script renames the condition column to `condition`
- **WHEN** the parent composes the seed of a step that grounds on the template
- **THEN** the `Template contract` section carries the notes whole

#### Scenario: No client, or no answer

- **GIVEN** a plan step whose grounding names a template, and a composition that binds no client or a service that does not answer
- **WHEN** the parent composes the seed
- **THEN** the Grounding section carries `Template contract: not retrieved (<reason>)`, the seed carries no `Template contract` section, and the child input carries no binding

#### Scenario: The served version differs from the plan

- **GIVEN** a plan step whose grounding names version 1.0.0 of a template, and a service that serves version 1.1.0
- **WHEN** the parent composes the seed
- **THEN** the section names the served version beside the reference as a caveat, and it lists each plan setting as unbound. The child input carries no binding

### Requirement: The plan settings bind to the render request

At dispatch the parent MUST intersect the `grounding.settings` of the step with the adaptable slots of the served contract, by name. Each setting that names an adaptable slot MUST become a bound slot of the `templateBinding` of the child input, with its source. The seed MUST list each bound setting under `Bound by the plan` with its value and its source. The seed MUST list each other setting under `Unbound settings` with its procedure step, its source when the setting has one, and the reason. A setting that names a pinned slot with a different value is a pinned conflict. A setting that names no slot stays a plan setting. A setting binds only when its value fits the slot. A fit is a member of the enum of the slot, a number for a number slot, or a boolean for a boolean slot. A free-text slot never binds, because a plan setting can be a policy word and not a value of the slot. A setting that does not fit its slot MUST be listed as unbound with the reason. `knowledge_template` MUST merge the bound slots under the model values. The tool MUST refuse a model value that differs from a bound value when no `overrides` entry names the slot with a reason. The refusal MUST come before the service call, and it MUST name the slot, the bound value, and its source. The decision record on disk MUST carry `bound_slots` and `settings_overrides`.

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

### Requirement: A local slot never leaves the machine

A slot the contract marks `local` (a path, a column name, a level label, a design formula) MUST NOT be sent to the service. `knowledge_template` MUST take the local slots from the `templateBinding` of the step, or from the contract when the binding carries none, and it MUST send the other slots only. The service answers with the marker `{{name}}` in each local slot, and the tool MUST bind the local values on the machine with the rule of the service (`bindLocalSlots`) before it writes the script. A local value the contract refuses MUST be refused by the tool, with the slot and the reason, before any write. The reason MUST end with the description of the slot, thus the agent reads the intent of a pattern beside the pattern. The briefing MUST mark each local slot.

#### Scenario: A path stays on the machine

- **GIVEN** a render call with `counts_path` and `lfc_shrink`
- **WHEN** the tool calls the service
- **THEN** the request carries `lfc_shrink` only, the written script carries the count path in the marked line, and the record names `counts_path` as bound on this machine

#### Scenario: A local value the contract refuses

- **GIVEN** a render call whose `counts_path` is a number
- **WHEN** the tool binds the local slots
- **THEN** the tool answers `match: rejected` with the slot and the reason, and no file is written

#### Scenario: A formula the pattern refuses

- **GIVEN** a local `design` slot with the pattern `condition\s*$` and the description "The design formula. It must end with condition."
- **WHEN** the agent sends `~ squamous + response`
- **THEN** the issue of `design` gives the pattern and the description of the slot, and the tool calls no service
