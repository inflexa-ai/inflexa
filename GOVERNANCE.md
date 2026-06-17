# Inflexa Project Governance

_Last updated: 2026-06-17 · Maintained by Inflexa, Inc._

## Overview

The Inflexa CLI is an open-source project **stewarded by Inflexa, Inc.** We want to be transparent about this from the start rather than imply a neutrality we don't yet have: this is a company-led open-source project, not an independent foundation. What that means in practice is that Inflexa, Inc. funds and leads ongoing development and holds final decision authority, and that we commit to running the project **in the open**, with a public roadmap, public discussion, and a genuine welcome for outside contributors.

The code is open source under the project's [`LICENSE`](./LICENSE), and it will remain fully usable on its own. How that relates to our commercial platform is described in [`COMMERCIAL.md`](./COMMERCIAL.md).

This document describes how decisions get made and how people can take on more responsibility over time. If external adoption grows to the point where a more independent governance model makes sense, we'll revisit this openly.

## Principles

- **Decisions happen in the open.** Substantive design and roadmap discussions take place in public issues, pull requests, and Discussions — not in private.
- **Anyone can contribute.** You don't need to be an employee, and you don't need to write TypeScript (see [Contributions](#contributions-are-broader-than-code)).
- **Scientific correctness matters.** Because Inflexa executes analyses on real biological data, contributions affecting analytical methods, the sandbox, or provenance receive extra scrutiny.
- **Honesty over theater.** We won't pretend to be vendor-neutral, and we won't hide commercial intent.

## Roles

### Contributors
Anyone who contributes to the project. This includes, but is far from limited to, opening issues, reviewing pull requests, improving documentation, contributing example datasets and workflows, filing validation or benchmark reports, and submitting code. There is no formal sign-up; you become a contributor by contributing. Contributions are accepted under the terms in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

### Maintainers
Maintainers have write access: they triage issues, review and merge pull requests, and shepherd releases. Maintainers include members of the Inflexa, Inc. team and trusted community members who have earned the role. Maintainers are expected to act in the interest of the project and its users, follow this governance document, and uphold the [Code of Conduct](./CODE_OF_CONDUCT.md).

### Core team (Inflexa, Inc.)
The core team sets overall direction, owns the public roadmap, makes releases, and holds **final decision authority** on technical disputes, scope, security response, and use of the Inflexa name (see [`TRADEMARK.md`](./TRADEMARK.md)). The core team is appointed by Inflexa, Inc.

## How decisions are made

Most decisions never need a formal process. Day to day, the project runs on **lazy consensus**: a proposal (an issue or pull request) is assumed to have support if no maintainer raises a substantive objection within a reasonable review window. Discussion is public, and maintainers weigh technical merit, scientific correctness, maintainability, and alignment with the roadmap.

When there is disagreement:

1. Contributors and maintainers discuss it in the relevant issue or pull request, aiming for consensus.
2. If consensus isn't reached, any maintainer may escalate to the core team.
3. The **core team makes the final decision** and records the rationale publicly.

Decisions with broad impact, significant new analytical capabilities, breaking changes, changes to the provenance model or sandbox security model, or changes to project scope, are documented as a proposal (issue or design doc) and opened for public comment before a decision.

## Becoming a maintainer

Maintainership is earned through sustained, high-quality participation: thoughtful reviews, reliable contributions, good judgment, and constructive conduct over time. Existing maintainers may nominate a contributor; the core team confirms the appointment. There is no fixed quota and no obligation to promote. It's a recognition of demonstrated trust and ongoing commitment. Maintainers who become inactive for an extended period may be moved to emeritus status, with a standing invitation to return.

## Contributions are broader than code

Inflexa is scientific software, and some of the most valuable contributions are not code:

- realistic example datasets and analysis problems
- new analysis workflows and pathway/reference integrations
- Docker sandbox image packages and tooling
- documentation, tutorials, and translations
- validation reports and reproducibility checks
- benchmark cases
- prompt and evaluation improvements
- bug reports and triage

All of these are recognized contributions. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for how to get started and for the contributor agreement terms.

## Roadmap and releases

The roadmap is maintained publicly and is shaped by community feedback alongside the core team's direction. Releases follow [semantic versioning](https://semver.org/) and ship with public release notes on a visible cadence. Security issues follow the separate process in [`SECURITY.md`](./SECURITY.md) and are not handled through normal public issues until a fix is available.

## Code of Conduct

Participation in the project is governed by our [Code of Conduct](./CODE_OF_CONDUCT.md). Maintainers and the core team are responsible for its enforcement.

## Relationship to the commercial product

Inflexa, Inc. also develops a commercial hosted platform. The open-source CLI is a fully featured product in its own right and is not a limited teaser; the commercial platform adds capabilities aimed at teams and organizations (collaboration, governance, managed infrastructure, compliance support). The boundary is described in [`COMMERCIAL.md`](./COMMERCIAL.md). Roadmap decisions for the open-source project are made on the project's merits and discussed in public.

## Changes to this document

Inflexa, Inc. may amend this governance document. Material changes will be made through a public pull request so the community can see and discuss them. Questions about governance can be raised in GitHub Discussions or sent to **oss-governance@inflexa.ai**.