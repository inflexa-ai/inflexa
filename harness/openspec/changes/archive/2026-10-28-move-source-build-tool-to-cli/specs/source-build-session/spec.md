## REMOVED Requirements

### Requirement: The build session is an embedder-bound interface

**Reason**: The tool and the interface move into the CLI as a host tool. The harness does not know them.

**Migration**: Refer to the `source-build-session` capability of the CLI.

### Requirement: The tool is one call per operation, keyed by a session id

**Reason**: The tool and the interface move into the CLI as a host tool. The harness does not know them.

**Migration**: Refer to the `source-build-session` capability of the CLI.

### Requirement: The session explores before the plan ask

**Reason**: The tool and the interface move into the CLI as a host tool. The harness does not know them.

**Migration**: Refer to the `source-build-session` capability of the CLI.

### Requirement: One ask approves the plan before any build command

**Reason**: The tool and the interface move into the CLI as a host tool. The harness does not know them.

**Migration**: Refer to the `source-build-session` capability of the CLI.

### Requirement: Each session command carries a session-scoped ask

**Reason**: The tool and the interface move into the CLI as a host tool. The harness does not know them.

**Migration**: Refer to the `source-build-session` capability of the CLI.

### Requirement: The session works on its own copy of a pristine snapshot

**Reason**: The tool and the interface move into the CLI as a host tool. The harness does not know them.

**Migration**: Refer to the `source-build-session` capability of the CLI.

### Requirement: The session sees the source and no store

**Reason**: The tool and the interface move into the CLI as a host tool. The harness does not know them.

**Migration**: Refer to the `source-build-session` capability of the CLI.

### Requirement: A session exec is a fresh shell keyed by the session

**Reason**: The tool and the interface move into the CLI as a host tool. The harness does not know them.

**Migration**: Refer to the `source-build-session` capability of the CLI.

### Requirement: The identity and version come from the package metadata

**Reason**: The tool and the interface move into the CLI as a host tool. The harness does not know them.

**Migration**: Refer to the `source-build-session` capability of the CLI.

### Requirement: The build strategy prefers the standard paths

**Reason**: The tool and the interface move into the CLI as a host tool. The harness does not know them.

**Migration**: Refer to the `source-build-session` capability of the CLI.

### Requirement: The commit ask shows the script and the record, then one clean run

**Reason**: The tool and the interface move into the CLI as a host tool. The harness does not know them.

**Migration**: Refer to the `source-build-session` capability of the CLI.

### Requirement: A lost session costs no store state

**Reason**: The tool and the interface move into the CLI as a host tool. The harness does not know them.

**Migration**: Refer to the `source-build-session` capability of the CLI.

### Requirement: A canceled turn stops the session work

**Reason**: The tool and the interface move into the CLI as a host tool. The harness does not know them.

**Migration**: Refer to the `source-build-session` capability of the CLI.
