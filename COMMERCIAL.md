# Inflexa: Open Source and Commercial

_Last updated: 2026-06-17 · Maintained by Inflexa, Inc._

## The short version

Inflexa, Inc. builds two things: this **open-source CLI**, and a **commercial hosted platform**. 

The open-source Inflexa CLI is a fully featured product, not a limited teaser or a trial. It runs entirely on your machine, it includes the full analytical and provenance capabilities, and it stays usable on its own under its [`LICENSE`](./LICENSE). For free, forever, including for commercial use.

The commercial platform exists to serve a different need: **biopharma teams and organizations**, not a single scientist on a laptop. This document explains exactly where the line is and what we commit to.

## What the open-source CLI gives you

Everything you need to do real, auditable analysis locally:

- **Full local analysis** across the supported workflows.
- **Agentic orchestration** - the local analysis agent that plans and runs your work.
- **Full provenance and lineage**, stored locally in SQLite, with reproduction and export.
- **Docker sandbox execution** of all generated code.
- **Local report / dossier generation.**
- **Bring-your-own-key to any supported LLM provider, plus local models** - so you can run end-to-end offline if you choose. (See `docs/privacy.md` for exactly what, if anything, leaves your machine in each mode.)
- **Single-user, single-machine** operation with no account required.

## What the commercial platform adds

The hosted Inflexa platform is aimed at the things a single scientist on one machine doesn't need, but a team or a regulated organization does:

- **Managed / shared compute** - run without installing or maintaining Docker locally.
- **Bring your own cloud** - deploy Inflexa into your own cloud account (AWS, GCP, or Azure) so data and compute stay inside your infrastructure and security perimeter.
- **Parallel plan execution** - run analysis steps in parallel with optimized resource allocation, so large or multi-step workloads finish faster on managed compute.
- **Multi-user collaboration** - shared dossiers, review, and handoff across a team.
- **Team memory** - remember team decisions, conventions, and preferences across people and sessions, so the agent carries your organization's accumulated context instead of starting fresh each run.
- **Organization-wide governance** - role-based access control, SSO, and audit at org scale.
- **Validated / attested environments** - support for regulated workflows.
- **Hosted experience and sharing** - the web UI and dossier publishing/sharing.
- **Managed model routing, private endpoints, and bring-your-own-storage at scale.**
- **Structured output stores for ML** - funnel analysis outputs into structured data stores, turning accumulated analyses into training-ready datasets for machine learning.
- **SLAs, deployment support, and professional services.**

## Why the line is where it is

The split is deliberate and, we think, defensible: **the open-source CLI is complete for an individual; the commercial layer sells what an organization needs to operate Inflexa across many people, machines, and compliance requirements** - collaboration, governance, managed infrastructure, attestation, and support. None of those require us to hold capabilities back from the CLI. They're genuinely additional, team-scale concerns.

## What we commit to

To make the open-core boundary trustworthy rather than just stated, we commit to the following:

- **We will not cripple the CLI to push the platform.** The CLI's analytical and provenance capabilities are not bait for an upsell.
- **We will not move existing open-source features behind a paywall.** Capabilities that ship in the open-source CLI stay in the open-source CLI.
- **No nagware.** The CLI won't pester you with upgrade prompts or interrupt your work to advertise.
- **No lock-in.** Your data, provenance database, and outputs are yours and remain portable. The CLI does not depend on our hosted services to function.
- **Roadmap in the open.** Open-source roadmap decisions are made on the project's merits and discussed publicly (see [`GOVERNANCE.md`](./GOVERNANCE.md)).

If you ever feel we've crossed one of these lines, open a Discussion and hold us to it.

## How the two relate technically

The CLI is standalone. It does not phone home to our platform to work, and you can use it with no Inflexa account. The commercial platform is a separate offering you opt into only if your team needs what it provides. There is no degraded "community mode" of the CLI - there is one CLI, and it's the open-source one.

## Using Inflexa commercially

You can use the open-source CLI commercially under its [`LICENSE`](./LICENSE) at no cost - inside a company, for client work, in a pipeline, anywhere the license permits. The one thing the license doesn't grant is use of our **name and logo**: please don't offer a competing hosted or managed service under the Inflexa brand. The details are in [`TRADEMARK.md`](./TRADEMARK.md).

## Talking to us

Interested in the commercial platform, or want to discuss something that doesn't fit neatly into either bucket (a partnership, an academic arrangement, a large deployment)? Reach us at **hello@inflexa.ai**. Bug reports, feature ideas, and questions about the open-source CLI belong in [issues](../../issues) and [Discussions](../../discussions) - that's the fastest path and keeps the conversation in the open.