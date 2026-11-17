## Purpose

Custom skills let a user add skill directories under `~/.config/inflexa/skills/`. The CLI serves them beside the built-in skills through the `SkillStore` of the catalog.

## ADDED Requirements

### Requirement: The skill store reads two roots

The CLI MUST build the `SkillStore` over the built-in skills root and `~/.config/inflexa/skills/`. A skill MUST be a directory whose `SKILL.md` frontmatter `name` equals the directory name. A release MUST NOT write into `~/.config/inflexa/skills/`.

#### Scenario: A custom skill is listed

- **GIVEN** the directory `skills/lab-protocols/` with a valid `SKILL.md`
- **WHEN** the catalog lists the skills
- **THEN** `lab-protocols` is in the list beside the built-in skills

#### Scenario: An upgrade keeps the custom skills

- **WHEN** a new release extracts its content
- **THEN** each directory under `~/.config/inflexa/skills/` is unchanged

### Requirement: A custom skill cannot use a built-in name

A custom skill whose `name` equals a built-in skill name MUST be left out of the store. `inflexa skill ls` MUST show it with an error that names the built-in skill.

#### Scenario: A name collision

- **GIVEN** the custom directory `skills/single-cell/`
- **WHEN** the user runs `inflexa skill ls`
- **THEN** the list shows the custom `single-cell` with a collision error, and agents read the built-in `single-cell`

### Requirement: Find searches a directory, or the skill folders of other harnesses

`inflexa skill find <dir>` MUST list the skills in the directory that the user names. With no directory, it MUST list the skills in the usual skill folders of other harnesses: `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills` and `~/.config/opencode/skills`. `inflexa skill import <dir>` MUST copy one skill directory into `~/.config/inflexa/skills/`.

#### Scenario: Find with no directory

- **GIVEN** a skill `plate-reader` in `~/.claude/skills`
- **WHEN** the user runs `inflexa skill find`
- **THEN** the list holds `plate-reader` with no conflict

#### Scenario: Import a skill

- **GIVEN** a directory with a valid `SKILL.md` whose `name` is `plate-reader`
- **WHEN** the user runs `inflexa skill import <dir>`
- **THEN** `~/.config/inflexa/skills/plate-reader/` holds a copy of the directory

### Requirement: A skill shows its text

`inflexa skill show <name>` and `GET /api/v1/skills/<name>` MUST give the title, the category, the tags, the description, the text of the `SKILL.md`, and the paths of the other files of the skill.

#### Scenario: Show a built-in skill

- **WHEN** the user runs `inflexa skill show single-cell`
- **THEN** the output holds the title "Single-Cell Analysis", the category `transcriptomics` and the text of the skill

### Requirement: The chat agent has the skill creator in a local install

The CLI MUST add the built-in skill `skill-creator` to the default skills of the chat agent `inflexa`. The harness defaults MUST stay the same, because a managed deployment cannot import a custom skill. A user MUST be able to detach the skill like a different default.

#### Scenario: The user detaches the skill creator

- **WHEN** the user runs `inflexa agent detach inflexa skill skill-creator`
- **THEN** the chat agent no longer has the skill, and `config.json` records the removal
