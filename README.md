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

Inflexa turns a plain-language analysis request into runnable code, executes it in an isolated Docker sandbox, and records exactly what happened so the result can be reproduced and audited. It runs entirely on your machine and works with the model provider of your choice, including local models for a fully offline workflow.

It is built for scientists, bioinformaticians, and engineers who need analysis they can trust and re-run, not just an answer in a chat window.

## Why Inflexa

- **Local-first.** Your data, code, and results stay on your machine. No account required.
- **Reproducible by construction.** Every run records its full provenance and lineage in a local SQLite database, with export and replay.
- **Sandboxed execution.** Generated code runs inside a Docker sandbox with no network egress and access only to your working directory.
- **Bring your own model.** Use any supported LLM provider via API key, or run local models end to end, offline.
- **Open source, in full.** The CLI is a complete product under Apache-2.0, not a limited trial. See [Open source and commercial](#open-source-and-commercial).

## How it works

1. You describe the analysis you want in plain language.
2. The agent plans the work and generates the code to carry it out.
3. The code runs in the Docker sandbox, against the data in your working directory.
4. Inputs, code, parameters, and outputs are recorded as a provenance graph in SQLite.
5. You inspect the lineage, export it, and reproduce the run later.

See [`docs/sandbox.md`](./docs/sandbox.md) for the execution model, [`docs/provenance.md`](./docs/provenance.md) for what gets recorded, and [`docs/privacy.md`](./docs/privacy.md) for exactly what, if anything, leaves your machine in each mode.

## Requirements

- [Bun](https://bun.sh/) — runtime and package manager
- [Docker](https://www.docker.com/), running locally — analyses execute in the sandbox image

## Quick start

Run from source:

```bash
git clone https://github.com/inflexa-ai/inf-cli.git
cd inf-cli
bun install

bun run dev                 # launch the TUI
bun run dev doctor          # check Docker, architecture, disk, runtime
```

Build a standalone `inflexa` binary:

```bash
bun run build               # compiles dist/inf-<os>-<arch>
```

## Configuration

Inflexa supports bring-your-own-key for supported LLM providers, as well as local models. Run `inflexa config` (or `bun run dev config`) to view and edit your configuration.

<!-- TODO: document supported providers and how to set API keys. -->

## Open source and commercial

Inflexa is developed by Inflexa, Inc. The open-source CLI in this repository is a complete, standalone product under [Apache-2.0](./LICENSE). A separate commercial hosted platform adds team- and organization-scale capabilities such as collaboration, governance, managed infrastructure, and compliance support. The boundary, and the commitments behind it, are described in [`COMMERCIAL.md`](./COMMERCIAL.md).

## Contributing

Contributions of all kinds are welcome: code, example datasets, documentation, validation reports, and triage. Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md). The project follows a [Code of Conduct](./CODE_OF_CONDUCT.md) and the governance model in [`GOVERNANCE.md`](./GOVERNANCE.md).

## Security

Please do not report security vulnerabilities in public issues. Follow the private disclosure process in [`SECURITY.md`](./SECURITY.md).

## License and trademarks

Code is licensed under [Apache-2.0](./LICENSE). The Inflexa name and logo are trademarks, handled separately in [`TRADEMARK.md`](./TRADEMARK.md): the code is yours to use and fork under the license, but a redistributed fork should be renamed.
