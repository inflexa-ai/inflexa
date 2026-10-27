# Spec Delta

## MODIFIED Requirements

### Requirement: A flight launches the provisioner with the acquisition egress classes

The flight MUST pass the egress allowlist of an acquisition to the
provisioner container, through its `INFLEXA_EGRESS_ALLOW` environment
variable. The launch adds the `NET_ADMIN` capability for the rule install. The
list MUST hold two host classes only: the pinned Python index with its file
host, and the configured pak repositories. The GitHub hosts and
`git.bioconductor.org` belong to the catalog build alone. An `acquire`
flight MUST NOT launch the provisioner with the variable unset, because an
unset variable gives open egress.

A source session and its clean run carry the session egress class instead:
the host of the git source with the hosts of its submodules, the dated
Ubuntu snapshot host for apt, and the Python index and the pak
repositories. The plan names each host, and the user approves the list
before any build command. The two classes stay apart: an `acquire` run
never gains a source host, and a session never gains a host beyond its own
class.

#### Scenario: The flight passes the two classes

- **WHEN** a flight launches the provisioner `acquire` run
- **THEN** the container env carries `INFLEXA_EGRESS_ALLOW` with the index hosts and the pak repositories, and no GitHub host

#### Scenario: No open-egress acquisition exists

- **WHEN** any code path of the CLI launches a provisioner `acquire` run
- **THEN** the launch sets the allowlist variable

#### Scenario: A session carries its own class

- **WHEN** the CLI starts a source session or its `acquire-source` clean run
- **THEN** the container env carries `INFLEXA_EGRESS_ALLOW` with the source host, the snapshot host, and the index and pak hosts, and the variable is never unset
