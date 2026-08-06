## MODIFIED Requirements

### Requirement: A missing store is offered, never fatal

The CLI SHALL, before launching a sandbox when the configured sandbox image is
not present, surface a one-line, actionable offer to run `inflexa sandbox pull`
and SHALL allow continuing. A missing image SHALL NOT silently dead-end: the offer
SHALL name the variant and the pull command. App launch SHALL NOT block on the
image. When an image is genuinely required, the hold happens at the first action
that makes a sandbox. The download gate (see `lib-store-download`) owns that
hold, and it reports its state while it holds.

#### Scenario: Missing image surfaces an offer

- **GIVEN** the configured sandbox image is not present locally
- **WHEN** a sandbox is about to launch
- **THEN** the CLI prints an offer to run `inflexa sandbox pull` (naming the variant) before proceeding to obtain it

#### Scenario: App launch does not wait for the image

- **GIVEN** the configured sandbox image is not present locally
- **WHEN** the app opens
- **THEN** chat is usable at once, and the image wait happens at the first sandbox action
