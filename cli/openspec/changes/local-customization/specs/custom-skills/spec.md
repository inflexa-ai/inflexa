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

### Requirement: The user names each directory to search or import

`inflexa skill find <dir>` MUST list the skills in the directory that the user names. `inflexa skill import <dir>` MUST copy one skill directory into `~/.config/inflexa/skills/`. The CLI MUST NOT search a directory of another harness on its own.

#### Scenario: Import a skill

- **GIVEN** a directory with a valid `SKILL.md` whose `name` is `plate-reader`
- **WHEN** the user runs `inflexa skill import <dir>`
- **THEN** `~/.config/inflexa/skills/plate-reader/` holds a copy of the directory
