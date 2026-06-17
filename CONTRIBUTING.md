# Contributing to Inflexa

Thanks for your interest in Inflexa. This is an open-source, local-first agentic AI orchestration CLI for reproducible biological data analysis, and it gets better the more scientists, engineers, and bioinformaticians shape it. This guide explains how to contribute and what to expect.

Participation is governed by our [Code of Conduct](./CODE_OF_CONDUCT.md), and the project is run according to [`GOVERNANCE.md`](./GOVERNANCE.md). Please read both.

## Ways to contribute (code is only one of them)

Inflexa is scientific software, so some of the most valuable contributions aren't code at all. All of these are recognized contributions:

- **Bug reports** - especially install and first-run failures, and anything platform-specific (macOS Intel/Apple Silicon, Linux, Windows/WSL).
- **Example datasets and analysis problems** - realistic, public-data examples (see [Adding an example](#adding-an-example)).
- **Analysis workflows** and pathway/reference integrations.
- **Docker sandbox** image packages, tooling, and size/reliability improvements.
- **Documentation** - quickstarts, tutorials, clarifications, translations.
- **Validation and reproducibility reports** - "I ran X on dataset Y and got Z; here's whether it reproduced."
- **Benchmark cases.**
- **Prompt and evaluation improvements.**
- **Code** - fixes and features.
- **Triage and review** - reproducing issues, reviewing pull requests.

If you're not sure where to start, look for issues labeled `good first issue` or `biology-example`, or open a Discussion.

## Before you start

- **Search first.** Check existing [issues](../../issues) and [Discussions](../../discussions) before opening a new one.
- **Discuss large changes early.** For anything beyond a small fix - new analytical capabilities, changes to the sandbox or provenance model, breaking changes, please open an issue or design proposal first so we can align before you invest time. See the decision process in [`GOVERNANCE.md`](./GOVERNANCE.md).

## Development setup

**Prerequisites**

- [Bun](https://bun.sh/) - the runtime and package manager this repo uses
- Docker (running) - required, since analyses execute in the sandbox image

**Get the project running**

```bash
git clone https://github.com/inflexa-ai/inf-cli.git
cd inf-cli
bun install
bun run build

# sanity-check your environment - checks Docker, architecture, disk, runtime
bun run dev doctor
```

If `doctor` or `demo` fails on a clean setup, that's itself a high-value bug report. Please open an issue with your OS, architecture, Docker version, and the full output.

## Making changes

- Branch from `main`: `git checkout -b fix/short-description` or `feat/short-description`.
- Use [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `fix(sandbox): pin bioconductor version`) - release notes and versioning are generated from commit history.
- Keep pull requests **focused**; one logical change per PR is far easier to review.
- Before pushing, make sure these pass locally:

```bash
bun run lint
bun run typecheck
bun test
```

- Add or update tests for any behavior you change.
- Update documentation when you change user-facing behavior.

## Testing

Inflexa runs on multiple platforms and across Docker versions, and that matters most at install and first run. When you change behavior:

- Add **unit tests** for logic.
- Add or extend **integration tests** for anything touching the CLI surface, the sandbox, or provenance.
- If a change is platform-sensitive, say so in the PR; CI runs the matrix (macOS Intel + Apple Silicon, Linux, Windows/WSL), but flagging it helps reviewers.

## Adding an example

Examples are one of the most persuasive things in the project, and a great first contribution. **Use public data, not toy data.** Each example under `examples/` should include:

- the **biological question** it answers;
- the **dataset source** (accession / URL) and how it's obtained;
- the **exact command(s)** to run;
- the **generated outputs** (figures, tables, report);
- the **lineage graph** / provenance export;
- **reproduction instructions**;
- **expected runtime** and **hardware requirements**.

The bar is: a stranger can clone the repo, run your example, and get the same artifacts.

## Changing analytical methods, the sandbox, or provenance

These areas get **extra scrutiny**, because Inflexa runs on real biological data and its whole premise is auditability:

- **Analytical methods:** be explicit about the method, cite the relevant literature where appropriate, and make sure tool/library versions are pinned. Scientific correctness is a review criterion, not an afterthought.
- **Sandbox:** preserve the security model (default no network egress, working-directory-only mounts, resource limits). Any change that loosens isolation must be called out explicitly and justified.
- **Provenance:** changes to what is recorded, or to the SQLite schema, must keep prior analyses reproducible (or document the expected variance) and update `docs/provenance.md`.

When in doubt, open a design proposal first.

## Submitting a pull request

Your PR description should explain **what** changed and **why**, and link the issue it addresses. Before requesting review, check:

- [ ] Lint, typecheck, and tests pass locally.
- [ ] Tests added/updated for the change.
- [ ] Docs updated if user-facing behavior changed.
- [ ] Commits follow Conventional Commits.
- [ ] Commits are **signed off** for the DCO (see below).
- [ ] The PR is focused on a single logical change.

Review follows the process in [`GOVERNANCE.md`](./GOVERNANCE.md): maintainers review for technical merit, scientific correctness, and maintainability, and merge by lazy consensus.

## Contributor agreement - Developer Certificate of Origin (DCO)

Inflexa uses the [Developer Certificate of Origin](https://developercertificate.org/) (DCO) version 1.1. The DCO is a lightweight statement that you have the right to submit your contribution under the project's license. You agree to it by **signing off** each commit:

```bash
git commit -s -m "fix(sandbox): pin bioconductor version"
```

This appends a `Signed-off-by: Your Name <your@email>` line to the commit message, certifying the DCO. CI checks for it; if you forget, you can amend with `git commit --amend -s` (or rebase to sign off multiple commits).

By contributing, you agree that your contributions are licensed under the project's [`LICENSE`](./LICENSE). Please use the name and address you're comfortable having in the public Git history.

## Security issues

**Do not** report security vulnerabilities in public issues, pull requests, or Discussions. Follow the private disclosure process in [`SECURITY.md`](./SECURITY.md). This is especially important for a tool that executes generated code on local data.

## Recognition and growing into a maintainer

Contributions of all kinds are recognized. Sustained, high-quality participation can lead to maintainership - see [`GOVERNANCE.md`](./GOVERNANCE.md) for how that works.

## Trademarks

You're free to use, fork, and modify the code under the license. The Inflexa **name and logo** are handled separately - see [`TRADEMARK.md`](./TRADEMARK.md). In short: forks distributed to users should be renamed.

## Questions

Open a [Discussion](../../discussions) or ask in an issue. Welcome aboard.