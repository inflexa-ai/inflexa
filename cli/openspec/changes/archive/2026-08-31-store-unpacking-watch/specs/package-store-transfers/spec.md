# package-store-transfers Delta

## ADDED Requirements

### Requirement: The unpacking of the catalog runs under a watch

The decompress of a layer MUST run under a liveness watch on the
decompressed bytes, with the two-minute window of the download watch. Each
`tar` run MUST run under a wall bound of `max(5 min, tarBytes / 1 MiB/s)`.
`tarBytes` is the size of the decompressed tar, because `tar` gives no
byte signal and its work scales with the inflated archive. A fired watch MUST settle the
row as `failed`, with a message that names the layer and the phase. The
child MUST free its lock on the normal path. No new transfer state
exists for this settle.

#### Scenario: A dead decompress settles as failed

- **GIVEN** a decompress that moves no bytes for two minutes
- **WHEN** the watch fires
- **THEN** the row settles as `failed`, the message names the layer and the phase, and the lock frees

#### Scenario: A hung tar run settles as failed

- **GIVEN** a `tar` run that lives past its wall bound
- **WHEN** the bound fires
- **THEN** the row settles as `failed`, and the retry command is named

### Requirement: The catalog row names its phase

The transfers row MUST carry a nullable phase. The catalog child MUST
write `download` while the bytes move and `unpacking` while the layers
unpack. An image transfer MUST keep a null phase. During the unpacking,
the byte counter MUST move `updated_at` on the progress cadence, thus the
row never freezes while the child works. `sandbox status` and `store ls`
MUST render the phase with the age of the last write.

#### Scenario: The heartbeat moves during the unpacking

- **GIVEN** a catalog transfer whose bytes are complete
- **WHEN** the child unpacks a layer
- **THEN** the row phase reads `unpacking`, and `updated_at` moves on the progress cadence

#### Scenario: An image transfer carries no phase

- **GIVEN** a runtime-image transfer
- **WHEN** the row is read
- **THEN** the phase is null, and the render of the image row does not change

## MODIFIED Requirements

### Requirement: The TUI shows one live row per transfer until it completes

The sidebar MUST render one progress row per live transfer: the kind, the
state, and a transfer meter, read by poll. The setup wizard renders no
transfer row: it starts the children, and it points at `inflexa sandbox
status`. Each
row MUST carry its OWN meter. A transfer with an exact total renders the
bar with the moved and the total bytes. The resolve of an image transfer
MUST take its total from the registry manifest, as the sum of the layer
sizes. A transfer with no total renders the moved bytes with the age of
the last write, thus a live row never reads as stuck.

While the catalog phase reads `unpacking`, the bar MUST stay full. The row
word MUST read `unpacking` in place of `downloading`. The tail MUST show
the age of the last write, thus a full meter never reads as stuck while
the child works.

When a transfer completes, its row MUST disappear. No "ready" line stays
behind, because a completed state that everyone has is noise. A terminal
failure row MUST stay visible, with a short hint. A key push on the row
MUST retry the transfer, and a command palette entry MUST give the same
retry.

#### Scenario: The rows disappear on completion

- **GIVEN** three transfers that complete
- **WHEN** the sidebar renders again
- **THEN** no transfer row and no "ready" line shows

#### Scenario: An image pull meters against its manifest total

- **GIVEN** a runtime-image transfer whose manifest layers sum to 3 GB
- **WHEN** the sidebar renders the row
- **THEN** the row shows the bar and the moved bytes against the 3 GB total

#### Scenario: A transfer with no total still shows motion

- **GIVEN** a transfer whose total is unknown
- **WHEN** the sidebar renders the row
- **THEN** the row shows the moved bytes and the age of the last write

#### Scenario: The unpacking phase shows motion at a full bar

- **GIVEN** a catalog transfer whose bytes are complete and whose phase reads `unpacking`
- **WHEN** the sidebar renders the row
- **THEN** the bar is full, the row reads `unpacking`, and the tail shows the age of the last write

#### Scenario: A failure stays visible

- **GIVEN** a catalog transfer that failed
- **WHEN** the sidebar renders
- **THEN** the row shows the failure and names `inflexa store download` as the retry
