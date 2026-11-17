## Purpose

The skill store lets the harness read skill files without a path of the host. It also defines the identity and the format of a skill, and the skill tools of each role.

## ADDED Requirements

### Requirement: The harness reads skills through a SkillStore

The harness MUST read each skill file through the `SkillStore` of the catalog:

- `list()` gives the name and the description of each skill.
- `files(skill)` gives the relative paths of the files of a skill.
- `read(skill, path)` gives the text of one file.

The harness MUST NOT take a skills directory.

#### Scenario: A store with no files on disk serves a skill

- **GIVEN** a `SkillStore` that keeps its files in memory
- **WHEN** an agent calls `skill_read` for one of its skills
- **THEN** the tool returns the text that the store gives

### Requirement: A skill id is the name in its frontmatter

Each `SKILL.md` MUST start with YAML frontmatter that holds `name` and `description`. The skill id MUST be `name`. `name` MUST equal the name of the directory of the skill, and it MUST NOT hold a `/`. Other fields MUST go under `metadata`. The harness MUST parse the frontmatter as YAML. Thus a block value, a quoted value and a multi-line value give the correct description.

#### Scenario: A block description reads whole

- **GIVEN** a `SKILL.md` whose `description` is a YAML block value on three lines
- **WHEN** the store lists the skill
- **THEN** the description holds the text of the three lines

#### Scenario: The shared pack has a flat id

- **WHEN** the built-in skills are listed
- **THEN** `omics-general` is a skill id, and `shared/omics-general` is not

### Requirement: A skill gives a title, a category and tags for a person

The frontmatter parse MUST give the first `# ` heading of the body as the title, `metadata.category` as the category, and `metadata.tags` as the tags. Each one is optional. The description stays the text for the agent, which opens with "Read before you". Each built-in skill MUST have a category.

#### Scenario: The title and the category of a built-in skill

- **WHEN** a host lists the skills
- **THEN** `single-cell` has the title "Single-Cell Analysis" and the category `transcriptomics`

### Requirement: Each role gets the skill tools

Each agent of each role MUST get `skill_search`, `skill_read`, and an index of its attached skills in its system prompt. The index MUST hold the id and the description of each attached skill. Both tools MUST be confined to the attached skills. An agent with no attached skill MUST get the tools, and each call MUST return the `no_skills` data variant.

#### Scenario: The chat agent reads an attached skill

- **GIVEN** an `inflexa` agent that attaches the skill `lab-protocols`
- **WHEN** the chat agent calls `skill_read` for `lab-protocols`
- **THEN** the tool returns its `SKILL.md`

#### Scenario: An agent cannot read a skill that it does not attach

- **WHEN** the reporter calls `skill_read` for a skill that it does not attach
- **THEN** the tool returns the `skill_not_declared` data variant

### Requirement: skill_read with no path reads the manifest

`skill_read` MUST accept a call with no `path`. Such a call MUST return the `SKILL.md` of the skill.

#### Scenario: A call by name loads the manifest

- **WHEN** an agent calls `skill_read` with `skill: "single-cell"` and no `path`
- **THEN** the tool returns the text of `single-cell/SKILL.md`

### Requirement: The built-in skill content passes a CI check

A CI test MUST make sure of these facts:

- Each built-in skill has a `SKILL.md` with valid frontmatter.
- The `name` of each built-in skill equals its directory name.
- Each built-in agent attaches only built-in skills that exist.

A released install MUST NOT do this check at boot.

#### Scenario: A typo in a built-in attachment fails CI

- **GIVEN** a built-in agent whose default skills name `single-cel`
- **WHEN** the CI test runs
- **THEN** the test fails and names the agent and `single-cel`
