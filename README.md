<p align="center">
  <img src="resources/inflexa-logo-white-bg.svg" alt="Inflexa" width="200" />
</p>

<p align="center">
  Local-first agentic AI orchestration for reproducible biological data analysis.
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" /></a>
  <a href="https://app.inflexa.ai"><img src="https://img.shields.io/badge/Try-Web%20UI-orange" alt="Web UI" /></a>
  <a href="https://www.linkedin.com/company/inflexa-ai"><img src="https://img.shields.io/badge/Follow-LinkedIn-0077B5" alt="Follow on LinkedIn" /></a>
</p>

---

Inflexa turns a plain-language analysis request into runnable code, executes it in an isolated sandbox, and records exactly what happened so the result can be reproduced and audited. It runs entirely on your machine and works with the model provider of your choice, including local models for a fully offline workflow.

It is built for scientists, bioinformaticians, and engineers who need analysis they can trust and re-run, not just an answer in a chat window.

## Why Inflexa

- **Local-first.** Your data, code, and results stay on your machine. No account required.
- **Reproducible by construction.** Every run records its full provenance and lineage in a local SQLite database, with export and replay.
- **Sandboxed execution.** Generated code runs in an isolated, unprivileged, resource-limited sandbox with no network access by default. The full isolation model is described in [`SECURITY.md`](./SECURITY.md).
- **Bring your own model.** Use any supported LLM provider via API key, or run local models end to end, offline.
- **Open source, in full.** The CLI is a complete product under Apache-2.0, not a limited trial. See [Open source and commercial](#open-source-and-commercial).

## Quick start

All you need is [Docker](https://www.docker.com/), running locally — analyses execute in the sandbox image. The `inflexa` CLI itself is self-contained.

```bash
npm install -g inflexa   # or: bun install -g inflexa

inflexa setup            # one-time: connect a model provider, pull the sandbox image, start local services
cd path/to/your/data     # go where your data lives
inflexa                  # launch the TUI
```

Prefer to run from source? See [Running from source](#running-from-source).

## Configuration

`inflexa setup` walks you through the model connection: sign in to a provider through the local proxy, or point Inflexa at your own endpoint — including a local model, for a fully offline workflow. It prompts for what it needs and tells you how to supply your key.

To change any of it later, run `inflexa config`.

## Running from source

Developing, or building the binary yourself, additionally requires [Bun](https://bun.sh/). The CLI lives in [`cli/`](./cli):

```bash
git clone https://github.com/inflexa-ai/inf-cli.git
cd inf-cli/cli
bun install

bun run dev                 # launch the TUI from source
bun run build               # compile a standalone dist/inflexa-<os>-<arch>
```

See [`cli/README.md`](./cli/README.md) for the full CLI developer guide, and [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the development environment and contribution workflow.

## Repository layout

This repository is a monorepo of independent subsystems — work inside the one you are changing; each has its own dependencies and tooling.

| Directory | What it is |
|-|-|
| [`cli/`](./cli) | The local-first TUI/CLI — this product. SQLite storage, auth, the chat UI. Start here to run from source. |
| [`harness/`](./harness) | `@inflexa-ai/harness`, the host-agnostic agent harness: agent loop, durable workflows, sandbox protocol, providers. The execution model and its design decisions live here — see [`harness/CONTEXT.md`](./harness/CONTEXT.md) and the specs in [`harness/openspec/specs/`](./harness/openspec/specs/). |
| [`skills/`](./skills) | Shared bioinformatics skill packs the agent loads at runtime. |
| [`templates/`](./templates) | Report-rendering templates. |
| [`images/`](./images) | The sandbox images: the base image with its Go execution server, and the published `python` / `python-r` variants with the analysis packages baked in. |
| [`scripts/`](./scripts) | Build, validation, and publishing tooling for the sandbox library store. |

## Open source and commercial

Inflexa is developed by Inflexa, Inc. The open-source CLI in this repository is a complete, standalone product under [Apache-2.0](./LICENSE). A separate commercial hosted platform adds team- and organization-scale capabilities such as collaboration, governance, managed infrastructure, and compliance support. The boundary, and the commitments behind it, are described in [`COMMERCIAL.md`](./COMMERCIAL.md).

## Contributing

Contributions of all kinds are welcome: code, example datasets, documentation, validation reports, and triage. Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md). The project follows a [Code of Conduct](./CODE_OF_CONDUCT.md) and the governance model in [`GOVERNANCE.md`](./GOVERNANCE.md).

## Security

Please do not report security vulnerabilities in public issues. Follow the private disclosure process in [`SECURITY.md`](./SECURITY.md).

## License and trademarks

Code is licensed under [Apache-2.0](./LICENSE). The Inflexa name and logo are trademarks, handled separately in [`TRADEMARK.md`](./TRADEMARK.md): the code is yours to use and fork under the license, but a redistributed fork should be renamed.
