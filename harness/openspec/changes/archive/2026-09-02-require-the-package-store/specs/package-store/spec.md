## MODIFIED Requirements

### Requirement: One inflexa.lock is the farm metadata contract

A farm MUST carry exactly one metadata file, `inflexa.lock`, beside its link
trees and its caches. The file MUST be JSON at schema version 1, with these
fields:

- `schema` — the number 1.
- `arch` — `"amd64"` or `"arm64"`.
- `packages` — one entry per linked distribution: `name`, `version`,
  `track` (the subtree of its links), `store_dir`, `hash` (the full tree
  sha256), and `requested`. `requested` obeys the PEP 376 meaning: true for
  a direct ask, false for a transitive dependency.
- `languages` — the per-language provenance. `python` carries `version` and
  `index`. `r` carries `version`, `bioc_releases`, and the embedded
  `pak_lock`. Each language object owns its own fields, and the JSON schema
  validates each shape.
- `warm` — the replay record, in the catalog farm only: per package, the
  `script_sha256` of its warm script and its `cache_entries`.
- `merge_conflicts` — the top-level entries that the link merge kept-first
  or skipped.

One schema definition MUST validate the shape at each read, and the mount
gate and the inventory MUST read this one file. The zod shape of the
harness is that definition — a second copy in another format can drift,
and nothing would read it. The mount gate MUST accept a farm
only when `inflexa.lock` parses and its schema version is known. The legacy
markers `packages.txt`, `meta.json`, and `lock.json` MUST NOT be part of the
farm contract.

The gate belongs to the party that can read the farm. A backend with a
host-readable farm path MUST prove the lock itself, before the mount. A
backend whose farm rides a volume the host cannot read MUST get the proof
from the farm resolver. There the resolver MUST answer `unavailable` when
the lock does not parse, and the backend mounts only a resolved farm. A K8s
configuration CAN name the host mountpoint of the libs volume, and the
backend then proves the lock itself, through the joined path. The sandbox
client factory MUST forward that root to the backend, because an embedder
composes through the factory and never builds the backend config itself.
Under a fixed farm source no resolver exists, thus the forwarded root
carries the only gate that shape can have.

An embedder CAN declare the fact `packageStore: "required"` on the sandbox
client config. Under the fact, a gate failure MUST refuse the create with
the `farm_unusable` error, which carries the farm path, the lock path, the
lock error type, and the cause, and no container and no Job is made.
Without the fact, a gate failure degrades. The sandbox client factory MUST
refuse at composition when the fact is set and no gate can run: no store
configured, or a K8s `fixed` farm source without the host mountpoint of the
libs volume.

#### Scenario: The gate reads the lock

- **GIVEN** a farm directory with a valid `inflexa.lock`
- **WHEN** the mount gate runs
- **THEN** the farm mounts, with no read of `packages.txt` or `meta.json`

#### Scenario: A farm without the lock is unusable

- **GIVEN** a farm directory with no `inflexa.lock`
- **WHEN** the mount gate runs
- **THEN** the sandbox degrades to `available: false` with a logged warning, and no store mount is made

#### Scenario: A volume-backed farm is proved by its resolver

- **GIVEN** a backend whose farm path is relative to a volume the host cannot read
- **WHEN** the resolver cannot parse the `inflexa.lock` of the farm
- **THEN** the resolution answers `unavailable` with the reason, and no container is made

#### Scenario: A host-readable volume root restores the backend gate

- **GIVEN** a K8s backend whose config names the host mountpoint of the libs volume
- **WHEN** the `inflexa.lock` of the resolved farm does not parse
- **THEN** the sandbox degrades to `available: false` with a logged warning, and no store mount is made

#### Scenario: A required store refuses an unusable farm on Docker

- **GIVEN** a Docker backend with `packageStore: "required"` and a resolved farm whose `inflexa.lock` does not parse
- **WHEN** `createSandbox` runs
- **THEN** the call refuses with `farm_unusable`, the error names the lock path and the lock error type, and no container is made

#### Scenario: A required store refuses an unusable farm on K8s

- **GIVEN** a K8s backend with `packageStore: "required"`, the host mountpoint of the libs volume, and a resolved farm whose `inflexa.lock` is absent
- **WHEN** `createSandbox` runs
- **THEN** the call refuses with `farm_unusable`, the lock path is the joined path under the mountpoint, and no Job is made

#### Scenario: A required store without a gate refuses at composition

- **GIVEN** a config with `packageStore: "required"` and no `libStorePath` on Docker, or a `fixed` farm source and no `libStorePvcRoot` on K8s
- **WHEN** `createSandboxClient` runs
- **THEN** it throws, and the message names the missing field
