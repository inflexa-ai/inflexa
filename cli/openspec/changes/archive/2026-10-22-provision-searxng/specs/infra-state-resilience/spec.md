# Spec Delta

## MODIFIED Requirements

### Requirement: Mount-source integrity before compose

Before any `compose up`, the system SHALL ensure every bind-mount source in the compose plan exists on the host with the correct type — file-typed sources exist as files (provisioned with their canonical content when absent), directory-typed sources exist as directories. The container engine SHALL never be the creator of a mount source. The integrity check SHALL live in one shared guard through which every compose entry point passes, and the mount manifest SHALL derive from the same facts that generate the compose file. Every compose entry point SHALL regenerate the compose file from the current configuration before the guard runs — the file the engine executes and the manifest the guard provisions SHALL always derive from the same facts in the same invocation, so a compose file written under an earlier configuration can never out-drift the guard. One-off container invocations outside compose that bind-mount a file-typed host path (e.g. the provider-login container) SHALL provision their mount sources through the same guard before the engine is invoked.

#### Scenario: Missing file-typed source is provisioned, not manufactured

- **WHEN** a compose entry point runs while the proxy config file is absent (cliproxy mode)
- **THEN** the proxy config file is written before the engine is invoked, and no directory is ever created at the file's path

#### Scenario: Missing directory-typed sources are created

- **WHEN** a compose entry point runs while the auth or postgres data directories are absent
- **THEN** they are created as directories before the engine is invoked

#### Scenario: The SearXNG settings file is provisioned before the engine

- **WHEN** a compose entry point runs in any connection mode and the SearXNG settings file is absent
- **THEN** the file is written with its canonical content before the engine is invoked, and a later run changes nothing in it

#### Scenario: Manifest covers every bind mount

- **WHEN** the compose file is generated for any connection mode
- **THEN** every bind-mount source in the generated file is covered by the integrity manifest for that mode

#### Scenario: Stale compose file cannot out-drift the guard

- **WHEN** the connection mode in config has changed since the on-disk compose file was generated and any compose entry point runs
- **THEN** the compose file is regenerated for the current mode before the guard runs, and the engine executes a file whose every mount source the guard just provisioned

#### Scenario: One-off container runs are guarded

- **WHEN** the provider-login container starts while the proxy config file is absent or occupied by an engine-manufactured empty directory
- **THEN** the source is provisioned or healed through the shared guard before the engine is invoked, and the engine never creates it
