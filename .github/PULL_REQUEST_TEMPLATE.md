<!--
Thanks for contributing to Inflexa! Keep PRs focused — one logical change per PR.
See CONTRIBUTING.md for the full guidelines.
-->

## What & why

<!-- What does this change do, and why? -->

Closes #<!-- issue number, if any -->

## Type of change

- [ ] Bug fix
- [ ] New feature / capability
- [ ] Documentation
- [ ] Refactor / internal change
- [ ] Analytical method, sandbox, or provenance change (gets extra scrutiny — see below)

## Checklist

- [ ] Lint, typecheck, and tests pass locally (`bun run lint`, `bun run typecheck`, `bun test`).
- [ ] Tests added or updated for the change.
- [ ] Documentation updated if user-facing behavior changed.
- [ ] Commits follow [Conventional Commits](https://www.conventionalcommits.org/).
- [ ] Commits are **signed off** for the DCO (`git commit -s`).
- [ ] This PR is focused on a single logical change.

## For analytical method / sandbox / provenance changes

<!-- Delete this section if it does not apply. -->

- [ ] **Methods:** the method is stated, relevant literature cited where appropriate, and tool/library versions are pinned.
- [ ] **Sandbox:** the security model is preserved (non-root, all capabilities dropped, `no-new-privileges`, read-only analysis tree with writes confined to the step's output directory, resource limits, and no host credentials in spawned commands); any loosening is called out and justified.
- [ ] **Provenance:** prior analyses remain reproducible (or the expected variance is documented).
