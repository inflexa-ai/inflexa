## ADDED Requirements

### Requirement: The CLI realizes the eyes of a report session

The composition root MUST bind the eyes seam that `assembleCoreRuntime` accepts. The harness refuses every report-session spawn under a composition with no eyes, thus this binding is what makes the report path exist on this host.

The realization MUST start one container for one look. A standing sidecar cannot serve this host, because an anchor puts each workspace root in a different user folder and no fixed mount set covers them.

The mount MUST repeat the workspace root of the scope on both sides. The browser navigates a `file://` URL of the host tree, and the container holds its own filesystem. Thus a container path that differed would resolve nothing. The mount argument MUST come from the runtime descriptor, because the two runtimes diverge on it.

The container MUST publish its devtools port on the loopback interface alone. The browser reads the workspace of the user, and a port on every interface would serve that tree to the network.

The container MUST carry its own deadline, and that deadline MUST NOT depend on this process. A process can die between the acquire and the release, thus no release of a caller is the guarantee.

The realization MUST bound how many browsers run at one time. The page gate of the harness bounds one endpoint, and each look here names a new endpoint.

The browser image MUST be pinned by digest. A moved tag would change what a look runs against, and the infrastructure images of this host are pinned the same way.

An acquire that fails MUST remove what it started, and it MUST give its slot back. No lease exists to do either.

The realization MUST run on the container runtime that the boot pinned already. Thus one boot names one container engine.

#### Scenario: A spawn passes the eyes gate

- **WHEN** the composition root assembles the harness runtime
- **THEN** it binds an eyes seam, and a report-session spawn does not refuse with `no_browser`

#### Scenario: One look mounts the root of its own analysis

- **WHEN** the seam acquires a lease for a scope
- **THEN** the container mounts the workspace root of that scope at the identical path

#### Scenario: A lost release still ends the browser

- **WHEN** a lease is acquired and no release ever runs
- **THEN** the container ends at its own deadline

#### Scenario: The count bound holds a look until a release

- **WHEN** the bound number of browsers already run and a further look acquires
- **THEN** the acquire waits, and it proceeds after one release

#### Scenario: A failed acquire leaves nothing behind

- **WHEN** the container starts and the endpoint never answers
- **THEN** the acquire removes the container, it gives its slot back, and it throws
