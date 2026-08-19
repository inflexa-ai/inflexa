# Issue tracker: GitHub

Issues and specs for this repository live as GitHub issues. Use the `gh` CLI for
all operations.

## Conventions

- **Make an issue**: `gh issue create --title "..." --body "..."`. Use a
  heredoc for a multi-line body.
- **Read an issue**: `gh issue view <number> --comments`. Filter the comments
  with `jq`, and also get the labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`
  with the applicable `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply or remove a label**: `gh issue edit <number> --add-label "..."` /
  `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

`gh` finds the repository from `git remote -v` automatically when it runs inside
a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set the flag to `yes` if this repository
treats an external PR as a feature request. `/triage` reads this flag.)_

When the flag is `yes`, a PR goes through the same labels and states as an
issue, with the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments`, and `gh pr diff <number>` for
  the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`.
  Then keep only an `authorAssociation` of `CONTRIBUTOR`,
  `FIRST_TIME_CONTRIBUTOR`, or `NONE`. Drop `OWNER`, `MEMBER`, and
  `COLLABORATOR`.
- **Comment, label, or close**: `gh pr comment`, `gh pr edit --add-label` /
  `--remove-label`, `gh pr close`.

GitHub gives one number space to issues and PRs. Thus a bare `#42` can be
either. Resolve it with `gh pr view 42`, and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Make a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

`/wayfinder` uses these operations. The **map** is a single issue, and its
**child** issues are the tickets.

- **Map**: a single issue with the label `wayfinder:map`. It holds the Notes /
  Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue that connects to the map as a GitHub sub-issue
  (`gh api` on the sub-issues endpoint). If sub-issues are not available, add
  the child to a task list in the map body. Then put `Part of #<map>` at the
  top of the child body. Labels: `wayfinder:<type>` (`research` / `prototype` /
  `grilling` / `task`). After a claim, the ticket is assigned to the driving
  dev.
- **Blocking**: the native issue dependencies of GitHub — the canonical
  representation, visible in the UI. Add an edge with
  `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`.
  The `<blocker-db-id>` is the numeric **database id** of the blocker
  (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, not the `#number` or the
  `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open
  blockers only — the live gate). If dependencies are not available, fall back
  to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is
  unblocked when every blocker is closed.
- **Frontier query**: list the open children of the map
  (`gh issue list --state open`, scoped to the sub-issues or the task list of
  the map). Drop each child with an open blocker
  (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the
  `Blocked by` line) or an assignee. The first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the first write of the
  session.
- **Resolve**: `gh issue comment <n> --body "<answer>"`. Then
  `gh issue close <n>`. Then append a context pointer (gist + link) to the
  Decisions-so-far of the map.
