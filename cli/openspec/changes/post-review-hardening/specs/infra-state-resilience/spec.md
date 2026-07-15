## MODIFIED Requirements

### Requirement: Mount-source integrity before compose

Before any `compose up`, the system SHALL ensure every bind-mount source in the compose plan exists on the host with the correct type — file-typed sources exist as files (provisioned with their canonical content when absent), directory-typed sources exist as directories. The container engine SHALL never be the creator of a mount source. The integrity check SHALL live at one shared seam through which every compose entry point passes, and the mount manifest SHALL derive from the same facts that generate the compose file. Every compose entry point SHALL regenerate the compose file from the current configuration before invoking the seam — the file the engine executes and the manifest the guard provisions SHALL always derive from the same facts in the same invocation, so a compose file written under an earlier configuration can never out-drift the guard. One-off container invocations outside compose that bind-mount a file-typed host path (e.g. the provider-login container) SHALL provision their mount sources through the same seam before the engine is invoked.

#### Scenario: Missing file-typed source is provisioned, not manufactured

- **WHEN** a compose entry point runs while the proxy config file is absent (cliproxy mode)
- **THEN** the proxy config file is written before the engine is invoked, and no directory is ever created at the file's path

#### Scenario: Missing directory-typed sources are created

- **WHEN** a compose entry point runs while the auth or postgres data directories are absent
- **THEN** they are created as directories before the engine is invoked

#### Scenario: Manifest covers every bind mount

- **WHEN** the compose file is generated for any connection mode
- **THEN** every bind-mount source in the generated file is covered by the integrity manifest for that mode

#### Scenario: Stale compose file cannot out-drift the guard

- **WHEN** the connection mode in config has changed since the on-disk compose file was generated and any compose entry point runs
- **THEN** the compose file is regenerated for the current mode before the guard runs, and the engine executes a file whose every mount source the guard just provisioned

#### Scenario: One-off container runs are guarded

- **WHEN** the provider-login container starts while the proxy config file is absent or occupied by an engine-manufactured empty directory
- **THEN** the source is provisioned or healed through the shared seam before the engine is invoked, and the engine never creates it

### Requirement: Expected failures carry named remediation

Failures with a diagnosable cause SHALL travel the `Result` error channel with a typed cause and SHALL be rendered to the user as the specific problem plus the exact command or action that fixes it. Raw operating-system error text (e.g. `EISDIR`, `EACCES`) SHALL only reach the user through last-resort backstops for genuinely unanticipated failures — a known-cause state surfacing as "failed unexpectedly" is a defect. When a diagnosis describes an occupying filesystem entry, it SHALL name what the occupant actually is (a non-empty directory, a symlink, another non-file entry) rather than assuming one kind.

#### Scenario: Diagnosable filesystem state is translated

- **WHEN** provisioning encounters a known-cause filesystem state (e.g. an occupied config path)
- **THEN** the user sees the specific diagnosis and remediation, not a raw errno message

#### Scenario: Occupant kind is named

- **WHEN** a symlink (or other non-directory entry) occupies the proxy config file's path
- **THEN** the failure names the path and describes the occupant as what it is — never with prose that only fits a directory — and deletes nothing

#### Scenario: Unknown errors still reach the backstop

- **WHEN** provisioning fails for a cause the system has no diagnosis for
- **THEN** the backstop reports the underlying error rather than swallowing it
