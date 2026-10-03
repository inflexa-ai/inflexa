## MODIFIED Requirements

### Requirement: An inflexa command downloads a GEO Series into the analysis's folder

The CLI SHALL provide a command that accepts a GEO Series accession (`GSE…`) and
fetches the Series' processed data host-side into a per-accession directory in the
target analysis's home folder. The command SHALL resolve that folder through the
resolve route of the local server (`POST /api/v1/analyses/resolve`), which runs the
shared context resolution — an explicit `--analysis` ref, else the marker of the
working folder of the command, which the command sends as an absolute path. The
download itself SHALL run in the command process, not in the server. It needs no
resolution tier of its own for the agent path:
`run_inflexa` starts the subprocess in the session analysis's folder, so a chat request
that names only the accession resolves there through the ordinary marker walk-up.

Downloading SHALL be the command's whole responsibility. It SHALL NOT record input
rows, emit provenance, stage, seed, (re)profile, or boot a harness runtime of its own.
Like each instance command, it starts the local server when none answers, and that
server boots its runtime. Because
it mutates no analysis state, it SHALL NOT require the analysis instance lock: the
resolve route takes no lock, thus the command is safe to run as a subprocess beside a
live chat of the same analysis. Making the
downloaded files inputs is a separate, explicit user action through the existing
add-inputs path, which already stages and profiles them like any other local file.

#### Scenario: A GSE accession is downloaded into the analysis's folder

- **GIVEN** a valid GEO Series accession and an existing analysis
- **WHEN** the command runs and the user approves
- **THEN** the Series' processed files are written to a per-accession directory in that analysis's folder and reported to the user

#### Scenario: An agent-driven run targets the chat analysis's folder with no ref

- **GIVEN** the conversation agent running the command through `run_inflexa` in an analysis-scoped session, with only the accession in the argv
- **WHEN** the command resolves its target folder
- **THEN** it resolves to the session analysis's folder, because the subprocess was started there

#### Scenario: The command records nothing about the analysis

- **GIVEN** a completed download in a subprocess
- **WHEN** the command finishes
- **THEN** no input rows were recorded, no provenance was emitted, the command booted no runtime of its own, and the analysis instance lock was never claimed

#### Scenario: The downloaded files become inputs only when the user asks

- **GIVEN** a completed download and a user who asks for the files to be added as inputs
- **WHEN** the existing add-inputs path runs
- **THEN** the files are enrolled, staged, and profiled identically to inputs added from any other local path
