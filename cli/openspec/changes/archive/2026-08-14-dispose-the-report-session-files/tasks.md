# Tasks: dispose-the-report-session-files

## 0. The harness link

- [x] 0.1 Run `bun run harness:local` from `cli`. The purge return and the directory helper reach the front door in a change that is not published yet.

## 1. The seams

- [x] 1.1 Widen the purge seam of `SessionSeams` for the erased thread ids that the store now gives back.
- [x] 1.2 Add a seam that removes one page directory by force. It gives back whether the directory went, and an absent directory is a success.
- [x] 1.3 Compose each path with the relative helper of the harness, joined onto the workspace root that the CLI already resolves. Spell no directory name.

## 2. The question

- [x] 2.1 Stack the file question over the name confirmation, in the shape that the analysis delete already uses. Its two answers are "remove" and "keep".
- [x] 2.2 Ask on every delete. The set of erased threads arrives after the answer, thus no test of the disk can precede the question.

## 3. The disposal

- [x] 3.1 Remove each directory after the erase succeeds, and only when the user accepted. Run it before the unbind and the landing, thus no file work races that round trip.
- [x] 3.2 Leave each file when the erase fails. The rows survive, and they still name their pages.
- [x] 3.3 Report both facts in one notice, in place of the success line that the flow raises today. Name each directory that stayed, and report the delete as a success.

## 4. The coverage

- [x] 4.1 Cover the question: every delete asks it, and a subtree with no page removes nothing and reports no failure.
- [x] 4.2 Cover the accept: each directory of the erased set goes.
- [x] 4.3 Cover the decline: the rows go, and each directory stays.
- [x] 4.4 Cover the failed erase: no directory goes.
- [x] 4.5 Cover a directory that resists removal: the delete reports success, and the notice names it.

## 5. The gates

- [x] 5.1 Run `bun run format:file` on the changed files under `src/`.
- [x] 5.2 Run `bun run typecheck` and `bun run lint`.
- [x] 5.3 Run the targeted files of the changed modules, and never the whole suite.
- [x] 5.4 Run `openspec validate dispose-the-report-session-files --strict`.
