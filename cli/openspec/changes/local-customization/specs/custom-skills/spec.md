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

### Requirement: An import reads a relative path inside the workspace of an analysis

`inflexa skill import` and `inflexa agent import` with `--analysis <id|name>` MUST read a relative path inside the workspace of that analysis. A path that leaves the workspace, also through a link, MUST be refused. An absolute path MUST stay as it is. Without `--analysis`, a relative path MUST read from the working directory. `run_inflexa` MUST add the analysis of the chat when the argv names none.

#### Scenario: The chat imports its draft

- **GIVEN** a chat that wrote `skills/lipidomics-lcms/SKILL.md` in its workspace
- **WHEN** the chat runs `inflexa skill import skills/lipidomics-lcms`
- **THEN** the skill is in the custom skills, with no approval prompt

### Requirement: Export copies a skill to a folder

`inflexa skill export <name> <dir>` MUST copy a built-in or a custom skill to `<dir>`. With `--analysis`, a relative path MUST write inside the workspace of that analysis. An existing folder MUST be refused, and `--replace` MUST overwrite it.

#### Scenario: The chat edits a custom skill

- **WHEN** the chat exports `lab-protocols` to `skills/lab-protocols`, changes the copy, and imports it with `--replace`
- **THEN** the custom skill holds the change, and no call asks for approval

### Requirement: An import takes no link

An import MUST refuse a skill folder that holds a link or a special file, and an agent file that is a link. The copy MUST NOT follow a link, and a refused copy MUST leave no folder in the custom skills. `skill find` MUST give a conflict for a found skill that holds a link.

#### Scenario: A link to a private key

- **GIVEN** a skill folder with a file `key` that links to a private key
- **WHEN** the user imports the folder
- **THEN** the import is refused with the name `key`, and the custom skills hold no copy

### Requirement: Replace overwrites a custom skill or agent, and keeps the replaced version

`--replace` MUST overwrite a custom skill or a custom agent of the same name. A built-in name MUST stay refused. Before the overwrite, the CLI MUST copy the replaced skill folder or agent file to `<data>/inflexa/replaced/skills/<name>` or `<data>/inflexa/replaced/agents/<id>.md`, in place of an older copy. The response and the output MUST give that path. An import of that path with `--replace` MUST restore the replaced version.

#### Scenario: A second version of a skill

- **GIVEN** a custom skill `lab-protocols`
- **WHEN** the user imports a new `lab-protocols` with `--replace`
- **THEN** the custom skill holds the new text, and the output gives the folder of the replaced version

#### Scenario: Undo a replace

- **WHEN** the user imports the folder of the replaced version with `--replace`
- **THEN** the custom skill holds the first text again

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

### Requirement: A client reads and writes each file of a skill

`GET /api/v1/skills/<name>/file?path=<path>` MUST give one file of a skill as text. `PUT /api/v1/skills/<name>/file` MUST write one file of a custom skill, and MUST make the folders of the path. `DELETE /api/v1/skills/<name>/file?path=<path>` MUST delete one file of a custom skill. These rules MUST apply:

- The path MUST be relative to the skill folder, with no `.` or `..` segment. A path that leaves the folder, also through a link, MUST be refused.
- A file that is not UTF-8 text, or that is larger than 512 KiB, MUST be refused.
- A built-in skill MUST refuse each write and each deletion.
- A `SKILL.md` MUST keep frontmatter that parses, with a `name` equal to the skill name. A deletion of the `SKILL.md` MUST be refused.
- A `SKILL.md` for a name that no skill has MUST make a new custom skill.
- A custom skill whose `SKILL.md` does not parse MUST still take a read and a write, so that a client can correct it.

#### Scenario: The GUI adds a reference to a custom skill

- **WHEN** a client writes `references/pcr.md` of `lab-protocols`
- **THEN** `inflexa skill show lab-protocols` lists the file, and a read gives its text

#### Scenario: A path that leaves the skill

- **WHEN** a client reads `../x.md` of `lab-protocols`
- **THEN** the server answers `validation_error`

### Requirement: The user deletes a custom skill

`inflexa skill rm <name...>` and `DELETE /api/v1/skills/<name>` MUST delete the folder of a custom skill. A built-in skill MUST be refused. `skill rm` MUST ask for approval in a chat.

#### Scenario: The chat removes a skill

- **WHEN** the chat runs `inflexa skill rm lab-protocols`
- **THEN** the user approves the command before it runs

### Requirement: A list gives the time of the last change

Each skill of `GET /api/v1/skills` and each custom agent of `GET /api/v1/catalog/agents` MUST give `modifiedAt`, the time of the last change to its `SKILL.md` or its file, so that a client can show the newest items first.

#### Scenario: A skill that a chat added

- **WHEN** the chat imports `lipidomics-lcms` and the user opens the list of the skills
- **THEN** `lipidomics-lcms` has the latest `modifiedAt` of the custom skills
