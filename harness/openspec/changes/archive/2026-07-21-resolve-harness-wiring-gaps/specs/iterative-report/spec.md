# iterative-report — delta

> Encodes the **recommended** direction for Decision 3 (option A — grant
> report-builder skill-tool access so its prompt's `skill_*` calls resolve)
> from `design.md`. If the owner picks option B (strip the prompt instead),
> this delta is dropped and `prompts/report-builder.ts` loses its skill guidance.

## MODIFIED Requirements

### Requirement: The report-builder runs in-process via runToTerminal, with no sandbox or Python

The report-builder agent SHALL be a non-plannable in-process agent (not a member
of the sandbox-agent catalog) driven by `runToTerminal` over `passthroughStep`.
Its roster SHALL be the four custom report tools (`build_report`,
`submit_report`, `mint_preview_url`, `preview_snapshot`), the in-process
`versionFs` surface (`write_file`, `edit_file`, `read_file`, `mkdir`), and the
read-only skill tools (`skill_search`, `skill_read`) scoped to the `report-html`
pack — all constructed inside the runner so the report/version tools share one
closure-captured `outcome` cell and the iteration's version-dir paths. The skill
tools SHALL be constructed via `createSkillTools({ skillsDir, skills:
["report-html"] })` so the design-system reference the builder prompt directs the
model to read (`skill_read("report-html", "references/design-system.md")`) is
actually reachable. The agent SHALL NOT have `execute_command` or any
sandbox/Python build path, and SHALL have no workspace discovery tools.

#### Scenario: The builder finalizes only through submit_report

- **WHEN** the report-builder run ends without `submit_report` recording a success outcome
- **THEN** `runToTerminal` grants one terminal-only salvage continuation; if the outcome cell is still empty the run is a failure

#### Scenario: The builder cannot shell out

- **WHEN** the report-builder needs to render the template
- **THEN** it calls the `build_report` tool (in-process Nunjucks) — there is no `execute_command` and no `python build.py` to invoke

#### Scenario: The builder can read the report-html skill pack

- **GIVEN** the report-builder prompt directs the model to `skill_read` the `report-html` design-system reference
- **WHEN** the model calls `skill_read("report-html", "references/design-system.md")`
- **THEN** the call resolves against the declared `report-html` pack rather than failing as an undeclared skill or an unavailable tool
