## MODIFIED Requirements

### Requirement: Mount-source integrity before compose

Before any `compose up`, the system SHALL ensure every bind-mount source in the compose plan exists on the host with the correct type — file-typed sources exist as files (provisioned with their canonical content when absent), directory-typed sources exist as directories. The container engine SHALL never be the creator of a mount source. The integrity check SHALL live at one shared seam through which every compose entry point passes, and the mount manifest SHALL derive from the same facts that generate the compose file. Every compose entry point SHALL regenerate the compose file from the current configuration before invoking the seam — the file the engine executes and the manifest the guard provisions SHALL always derive from the same facts in the same invocation, so a compose file written under an earlier configuration can never out-drift the guard. One-off container invocations outside compose that bind-mount a file-typed host path (e.g. the provider-login container) SHALL provision their mount sources through the same seam before the engine is invoked. A named volume of the container engine is not a mount source, because the engine holds it and no host path backs it. Thus the manifest MUST NOT list a host directory for a service that persists into a named volume. The guard MUST NOT make such a directory.

#### Scenario: Missing file-typed source is provisioned, not manufactured

- **WHEN** a compose entry point runs while the proxy config file is absent (cliproxy mode)
- **THEN** the proxy config file is written before the engine is invoked, and no directory is ever created at the file's path

#### Scenario: Missing directory-typed sources are created

- **WHEN** a compose entry point runs on a host that is not Windows while the auth or postgres data directories are absent
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

#### Scenario: A named volume adds no mount source

- **WHEN** a compose entry point runs on a Windows host, where the Postgres service persists into a named volume
- **THEN** the manifest lists no Postgres data directory, and the guard makes no directory for it
- **AND** in cliproxy mode the manifest still lists the proxy config file and the credential directory
