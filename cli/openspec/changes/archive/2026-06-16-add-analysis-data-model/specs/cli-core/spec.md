## ADDED Requirements

### Requirement: Default command resolves and acts on context

The system SHALL register a default `inf [--analysis <x>] [--project <p>]` command (commander root action) that runs `resolveContext(process.cwd(), flags)`, prints `describeContext(ctx)` first (loud context), then acts by kind: `analysis` → open chat; `anchor` with one analysis → open it, with several → a picker including "start a new one", with none → confirm starting one; `pick` → a picker over the candidates; `empty` → confirm starting a new analysis at cwd; `copy` → surface the copy and direct the user to the move backstop (clone/fork resolution is deferred — see move-backstop). The action lives in `src/tui/launch.tsx` as `launchDefault` (it opens a chat).

#### Scenario: Empty directory offers to start one

- **WHEN** `inf` runs in a directory with no anchor
- **THEN** it prints the empty context and asks to start a new analysis here
- **AND** confirming creates an analysis at cwd and opens chat

#### Scenario: Single analysis opens directly

- **WHEN** `inf` runs where context resolves to exactly one analysis
- **THEN** it prints the context and opens that analysis's chat without a picker

#### Scenario: Multiple analyses show a picker

- **WHEN** context resolves to several analyses
- **THEN** it prints the context and renders a picker including a "start a new one" option

#### Scenario: Copied folder is not auto-resolved

- **WHEN** context resolves to a copied folder
- **THEN** it prints that the folder looks like a copy and directs to `inf repair` / `inf relocate`, without opening or auto-resolving

### Requirement: inf new creates and opens an analysis

The system SHALL register `inf new [name] [paths...] [--project <p>] [--output <path>]` that resolves `--project` by id or name, validates/prompts the name as a `Str256`, calls `createAnalysis` with cwd, name, input paths, project, and output override, prints the resolved output directory, then opens chat. The action lives in `src/tui/launch.tsx` as `launchNew`.

#### Scenario: Create with name and inputs

- **WHEN** `inf new "Batch 42" ./data` runs
- **THEN** an analysis is created with those inputs, its output directory path is printed, and chat opens

#### Scenario: Missing name is prompted

- **WHEN** `inf new` runs with no name
- **THEN** it prompts for a name, re-asking until a valid `Str256` is given, before creating the analysis

### Requirement: inf ls lists analyses

The system SHALL register `inf ls [--project <p>]` (`runLs` in `src/modules/analysis/ls.ts`) that lists recent analyses, scoped to a project (resolved by id or name) when given.

#### Scenario: List shows recent analyses

- **WHEN** `inf ls` runs with existing analyses
- **THEN** each analysis is printed with its identifying details

#### Scenario: Scoped by project name

- **WHEN** `inf ls --project trial-42` runs
- **THEN** only analyses grouped under that project (resolved by name) are listed

### Requirement: inf resume reopens chat

The system SHALL register `inf resume <id|name>` that resolves the analysis via `matchAnalysis`, errors with a non-zero exit when none matches, lists candidates and exits when a name is ambiguous, otherwise opens its chat. The action lives in `src/tui/launch.tsx` as `launchResume`.

#### Scenario: Resume by id or name

- **WHEN** `inf resume <id-or-name>` matches exactly one analysis
- **THEN** its chat opens

#### Scenario: No match exits non-zero

- **WHEN** nothing matches
- **THEN** it prints an error and exits non-zero

#### Scenario: Ambiguous name lists candidates

- **WHEN** a name matches several analyses
- **THEN** it lists the candidates and exits without opening

### Requirement: inf open opens the output directory

The system SHALL register `inf open <id|name>` (`runOpen` in `src/modules/analysis/open.ts`) that resolves the analysis, ensures its output directory exists, prints the path, and opens it with the platform opener (`open`/`xdg-open`/`start`).

#### Scenario: Open the output directory

- **WHEN** `inf open <id-or-name>` resolves an analysis
- **THEN** its output directory is created if needed, the path is printed, and the OS opener is invoked

### Requirement: inf status prints resolved context

The system SHALL register `inf status [--analysis <x>] [--project <p>]` (`runStatus` in `src/modules/analysis/status.ts`) that runs `resolveContext`, prints `describeContext` plus details (anchor path, anchor id, analyses found, or that `inf` would start a new analysis here), and launches nothing.

#### Scenario: Status is read-only

- **WHEN** `inf status` runs
- **THEN** it prints the resolved context and details and does not open chat

### Requirement: Commander registry with lazy-imported actions

The commands SHALL be registered on the commander root in `src/cli/index.ts`, each lazy-importing its action (text commands from their module, chat-opening commands from `src/tui/launch.tsx`). Interactive confirms and pickers SHALL use the shared clack-based prompts in `src/lib/cli.ts` (`confirm`, `select`, `promptText`), declining gracefully on a non-interactive stdin — no bespoke `readline` picker.

#### Scenario: Actions are lazy-imported

- **WHEN** a command runs
- **THEN** only that command's action module is imported, keeping startup paths lean

#### Scenario: Non-interactive prompt declines

- **WHEN** a confirm/pick is reached with a non-interactive stdin
- **THEN** the prompt layer declines rather than hanging
