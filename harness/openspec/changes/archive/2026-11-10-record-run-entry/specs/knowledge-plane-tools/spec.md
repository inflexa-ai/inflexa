## MODIFIED Requirements

### Requirement: The plan settings bind to the render request

At dispatch the parent MUST intersect the `grounding.settings` of the step with the adaptable slots of the served contract, by name. Each setting that names an adaptable slot MUST become a bound slot of the `templateBinding` of the child input, with its source. The seed MUST list each bound setting under `Bound by the plan` with its value and its source. The seed MUST list each other setting under `Unbound settings` with its procedure step, its source when the setting has one, and the reason. A setting that names a pinned slot with a different value is a pinned conflict. A setting that names no slot stays a plan setting. A setting binds only when its value fits the slot. A fit is a member of the enum of the slot, a number for a number slot, or a boolean for a boolean slot. A free-text slot never binds, because a plan setting can be a policy word and not a value of the slot. A setting that does not fit its slot MUST be listed as unbound with the reason. `knowledge_template` MUST merge the bound slots under the model values. The tool MUST refuse a model value that differs from a bound value when no `overrides` entry names the slot with a reason. The refusal MUST come before the service call, and it MUST name the slot, the bound value, and its source. The decision record on disk MUST carry `bound_slots` and `settings_overrides`.

A departure of the plan changes a setting before the intersection. A setting that a departure names with a value MUST take the value of the departure, with the source `departure from <claim id>`. A setting that a departure names with no value MUST NOT bind. The seed MUST list that setting as unbound, with the claim id and the reason. The binding MUST carry the departures of the step, and the decision record MUST carry them as `departures`.

A rule can give a setting as a policy word, which is not a value of a slot. The served contract can carry `setting_bindings`. Each entry maps one setting with one value to one slot with one slot value. The service gives no more than one entry for one setting with one value, and the parent MUST take the first such entry. The parent MUST bind the slot of an entry when a setting of the step has the name and the value of that entry. The parent MUST read the setting after its departure. Thus a departure that changes the value binds the slot only when an entry maps the new value. A departure with no value MUST NOT bind the slot, and it MUST NOT name the slot as excluded. The source of the bound slot MUST name the setting and the source of the setting. The parent MUST NOT bind the slot of an entry when the slot is not an adaptable slot of the served contract, when the slot is local, or when the slot value does not fit the slot. The seed MUST list that setting as unbound with the reason. A slot takes the first value that binds it. A later setting that gives a different value MUST be listed as unbound.

A script does some settings with no slot, for example the adjustment of a fit script. The served contract can carry `settings_by_construction`. Each entry names one setting with the value that the script does. The service gives no more than one entry for one setting, and the parent MUST take the first such entry. An entry whose setting is the name of a slot of the served contract says nothing, because the slot carries that setting. The parent MUST read the setting after its departure. A setting of the step can have the name and the value of an entry. The seed MUST then list it under `Done by the script` with its procedure step and its source. The seed MUST NOT list that setting as unbound, and the binding MUST NOT hold a slot or a source for it. When the setting has a different value, the seed MUST list it as unbound, and the line MUST name the value that the script does. A departure with no value can name the setting. The seed MUST then list it as unbound, and the line MUST say that the script does it with no slot. The binding MUST NOT name an excluded slot for it. When the served version differs from the version of the plan, the seed MUST list no setting under `Done by the script`.

A template can pin a slot at the value of a setting of the step. The script reads the pinned value, thus the setting needs no act of the agent. The seed MUST then list that setting under `Done by the script` with its procedure step and its source. The line MUST say that the template pins the slot at the same value. The seed MUST NOT list that setting as unbound.

A script can fit the model of a fit in a step before it again. The served contract of such a template can carry `carried_slots`. The entry names the templates of that fit in `from_templates`. It names the slots that the parent binds in `bind`, and the slots that the seed shows in `show`. The parent MUST read the decision records of the steps that the step depends on. A record whose template is in `from_templates` is the record of the reported fit. With one such record, the parent MUST bind each `bind` slot to the value of the same slot in that record. The source of the bound slot MUST name the step and the template of the record. The parent MUST bind a local slot also, and `knowledge_template` binds that value on the machine. The parent MUST NOT bind a slot that has no value in the record, because the default of the template then applies. A setting of the step MUST NOT bind that slot, and the seed MUST list that setting as unbound. The parent MUST NOT bind a value that the slot of the served contract does not take. The seed MUST list that value as unbound with the reason. The seed MUST show the value of each `show` slot, and the binding MUST NOT hold it. A `show` slot is a path, or a slot whose value the script of the fit can change at run time. A carried slot binds before the settings of the step. A setting of the step that gives the slot a different value MUST be listed as unbound. A setting of the step MUST NOT bind a `show` slot, and the seed MUST list that setting as unbound. A departure with no value MUST NOT name a slot that holds a value of the reported fit as excluded. With no such record, or with more than one, the parent MUST bind no carried slot, and the seed MUST give the reason. The parent MUST also bind no carried slot when the record lists a change of the script after the render. The parent MUST compare the digest of the script on disk with the digest in the record. It MUST bind no carried slot when the two differ. The record MUST also hold a run of the rendered script that ended with exit code 0. Such a run is an entry of `runs` whose `sha256` is the `written_sha256` of the record. Without such a run, the parent MUST bind no carried slot, and the seed MUST give the reason. The same applies when the parent did not read each record file of a dependency. In each of these cases, a setting of the step MUST NOT bind a carried slot. When the served version differs from the version of the plan, the parent MUST read no carried slot.

A template gives each slot a value, and an omitted slot takes the default of the template. Thus the binding MUST name an adaptable slot as excluded when a departure with no value names it. `knowledge_template` MUST refuse a render that sends no value for an excluded slot. It MUST also refuse a value with no override. The decision record MUST keep the override of an excluded slot with a `plan_value` of `null`.

#### Scenario: A policy word on an integer slot

- **GIVEN** a step whose settings hold `min_samples = smallest_group_size` and `min_count = 10`
- **WHEN** the seed composes against a contract whose two slots are integers
- **THEN** the binding holds `min_count = 10` and not `min_samples`, and the seed lists `min_samples` as unbound with the reason

#### Scenario: An unbound setting keeps its source

- **GIVEN** a step whose settings hold `alpha = 0.01` with the source `doi:10.1186/s13059-014-0550-8`, and a contract that pins `alpha` at 0.05
- **WHEN** the seed composes
- **THEN** the line of `alpha` under `Unbound settings` names the procedure step and the source

#### Scenario: A setting that the template pins at the same value

- **GIVEN** a step whose settings hold `alpha = 0.05`, and a contract that pins `alpha` at 0.05
- **WHEN** the seed composes
- **THEN** the seed lists `alpha` under `Done by the script`, and the line says that the template pins it at the same value
- **AND** the seed does not list `alpha` as unbound

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

#### Scenario: A policy word that the template maps

- **GIVEN** a step whose settings hold `depth_policy = low_depth_panel` with the source `rule:R-0571`
- **AND** a served contract whose `setting_bindings` map that setting and that value to `min_count = 5`
- **WHEN** the seed composes
- **THEN** the binding holds `min_count = 5`, and its source names the setting `depth_policy` and `rule:R-0571`

#### Scenario: A departure from a mapped policy word

- **GIVEN** the same step and the same contract, and a departure that gives `depth_policy` a value that no entry maps
- **WHEN** the seed composes
- **THEN** the binding holds no `min_count`, and the seed lists `depth_policy` as unbound
- **WHEN** the departure gives `depth_policy` no value
- **THEN** the binding holds no `min_count`, and it names no excluded slot

#### Scenario: A map that the served contract does not take

- **GIVEN** a served contract whose `setting_bindings` name a slot that is local, a slot that the contract does not hold, or a value that does not fit the slot
- **WHEN** the seed composes
- **THEN** the binding holds no value for that slot, and the seed lists the setting as unbound with the reason

#### Scenario: A setting that the script does with no slot

- **GIVEN** a step whose settings hold `adjustment = BH` with the source `rule:R-0003`
- **AND** a served contract whose `settings_by_construction` hold `adjustment = BH`
- **WHEN** the seed composes
- **THEN** the seed lists `adjustment` under `Done by the script` with its procedure step and its source
- **AND** the seed does not list it as unbound, and the binding holds no slot for it

#### Scenario: A plan value that the script does not do

- **GIVEN** the same step and the same contract, and a departure that gives `adjustment = bonferroni`
- **WHEN** the seed composes
- **THEN** the seed lists `adjustment` as unbound, and the line names the value `BH` that the script does
- **WHEN** the departure gives `adjustment` no value
- **THEN** the seed lists `adjustment` as unbound, and the line says that the script does it with no slot
- **AND** the binding names no excluded slot

#### Scenario: A slot that takes the value of the reported fit

- **GIVEN** a step that depends on `T1S2`, and a served contract whose `carried_slots` name `tpl-fit`, bind `min_count`, and show `counts_path`
- **AND** one decision record of `tpl-fit@2.0.0` in `T1S2` whose slots hold `min_count = 5` and a value of `counts_path`
- **AND** the record holds a run of the rendered script that ended with exit code 0
- **WHEN** the seed composes
- **THEN** the binding holds `min_count = 5`, and its source names `T1S2` and `tpl-fit@2.0.0`
- **AND** the seed shows the value of `counts_path`, and the binding does not hold it

#### Scenario: A setting of the step that differs from the reported fit

- **GIVEN** the same step, and a setting of the step that gives `min_count = 10`
- **WHEN** the seed composes
- **THEN** the binding holds `min_count = 5`, and the seed lists the setting as unbound

#### Scenario: No one record of the reported fit

- **GIVEN** the same contract, and no decision record of `tpl-fit` in the steps that the step depends on
- **WHEN** the seed composes
- **THEN** the binding holds no carried slot, and the seed gives the reason
- **WHEN** those steps hold two decision records of `tpl-fit`
- **THEN** the binding holds no carried slot, and the seed names the two records

#### Scenario: A fit script that changed after its render

- **GIVEN** the same contract, and one decision record of `tpl-fit` whose `unvetted_edits` hold an entry
- **WHEN** the seed composes
- **THEN** the binding holds no carried slot, and the seed names the record and gives the reason

#### Scenario: A render of the fit that did not run

- **GIVEN** the same contract, and one decision record of `tpl-fit` with no entry in `runs`
- **WHEN** the seed composes
- **THEN** the binding holds no carried slot, and the seed names the record and gives the reason
- **WHEN** the only run of the record ended with exit code 1, or ran different bytes
- **THEN** the binding holds no carried slot

#### Scenario: A render of an excluded slot

- **GIVEN** a binding that names `lfc_shrink` as excluded
- **WHEN** the model renders with no `lfc_shrink`, or with `lfc_shrink` and no override
- **THEN** `knowledge_template` refuses the render
- **WHEN** the model renders with `lfc_shrink = none` and an override with the reason
- **THEN** the decision record keeps the override with a `plan_value` of `null`

### Requirement: The decision record follows the script

The record on disk MUST carry the step, the claims, the digest of the script as the service rendered it, and `written_sha256`, the digest of the bytes the tool wrote. `edit_file` on a script under `scripts/` that has a record MUST append an entry to `unvetted_edits` with the path, a note, and the digest after the change. Before `execute_command` runs a script that has a record, it MUST compare the script with the last recorded digest, and a difference MUST be appended as an unvetted change with the digest of the bytes that run. A script without a record is untouched.

A command can name its script inside a shell line: the one element of an `sh -c` call, or a string after `bash -c`. `execute_command` MUST find each word of such a line that has a script extension. It MUST make the same comparison for each one. A word ends at whitespace, at a shell operator, at a quote, and at the `=` of an option. A `cd` in the line moves the words after it, and a subshell can end that move. Thus `execute_command` MUST resolve a relative word against the cwd of the command. It MUST also resolve the word against each directory that a `cd` before the word can give. The command MUST run as the model sent it.

After `execute_command` runs a script that has a record, it MUST append an entry to `runs` in the record. The entry MUST hold `exit_code`, the exit code of the command, and `sha256`, the digest that the comparison before the run read. The entry MUST also hold `invocation`, the id of the tool call. A tool call that the host does again after a recovery MUST write no second entry. The tool MUST write the entries of one record in order, thus two commands that end together lose no entry. The tool MUST NOT read the script again after the run, because the run can change the script. The tool MUST write the entry only when the exit code of the command is the exit code of the script. A direct argv gives that when the script is the command. It also gives that when the script comes after a runner, for example `Rscript`, `python`, or `bash`. Only an option that still runs the script can be between the two, for example `--vanilla`. An option such as `--version` or `-e` MUST write no entry. A `cd` in a chain of `&&` moves the script, and a `cd` that the host cannot resolve MUST write no entry. A shell line gives that only when it is one such command, or a chain of `&&` that ends with one. Each command before the last one of a chain MUST be `cd` with one directory or `mkdir -p` with one directory. An output redirect and `2>&1` are permitted after the command. A line with a pipe, a list, a subshell, a quote, an expansion, or an input redirect MUST write no entry. A command that reads the script as data, for example `cat`, MUST write no entry. A failed write of the entry MUST NOT fail the call, because the command already ran. A record MUST keep no more than its last 50 entries.

#### Scenario: An edit lands on the record

- **GIVEN** a rendered script and its record
- **WHEN** `edit_file` changes a marked line
- **THEN** the record lists the edit with the digest of the script after the change

#### Scenario: A change no tool recorded

- **GIVEN** a rendered script whose bytes differ from the last recorded digest
- **WHEN** `execute_command` runs it
- **THEN** the record lists the change with the digest of the bytes that run, before the command runs

#### Scenario: A changed script in a shell line

- **GIVEN** a rendered script whose bytes differ from the last recorded digest
- **WHEN** `execute_command` runs the one element `cd scripts && Rscript de.R > log.txt`
- **THEN** the record lists the change with the digest of the bytes that run, before the command runs
- **AND** the command runs with no change

#### Scenario: A run lands on the record

- **GIVEN** a rendered script and its record
- **WHEN** `execute_command` runs `Rscript scripts/de.R`, and the command ends with exit code 0
- **THEN** the two copies of the record hold a `runs` entry with `exit_code` 0 and the digest of the script
- **WHEN** `execute_command` runs `cat scripts/de.R`, or the one element `Rscript scripts/de.R | tee log.txt`
- **THEN** the record gets no entry
