# Tasks: switch-report-capability-to-session

## 1. The spawn payload

- [x] 1.1 Add the brief argument to `spawnReportSession` in `src/app/spawn-report-session.ts`. The fields are `objective`, `audience`, `angle`, optional `exclusions`, and optional `openQuestions`.
- [x] 1.2 Compose the seed message at the spawn: the brief, then the copy of the working-memory render. Append it through `appendTurn`.
- [x] 1.3 On a failed seed write, purge the child and return the fault as typed data.
- [x] 1.4 Cover the seed with tests: the seed lands, the seed stays frozen after a memory change, and a failed seed removes the child.

## 2. The delta reads on the spawn module

- [x] 2.1 Add the delta read to `src/app/spawn-report-session.ts`. It gives the greatest child anchor and the latest seq of the parent.
- [x] 2.2 Walk each page of the children listing, because the listing orders by `updated_at` and not by anchor. An archived child does not count.
- [x] 2.3 Cover the read with tests: no child, one child at the end, one child below the end, and two pages of children.

## 3. The tool

- [x] 3.1 Make `src/tools/start-report-session.ts` with `defineTool`. The input carries the brief fields and the optional `newSessionAnyway` boolean.
- [x] 3.2 Read the parent from `scope.threadId`. A scope with no thread id refuses as typed data in the ok channel.
- [x] 3.3 Run the eyes gate first, from `hasBrowserUrl(chrome)`. A composition without eyes returns the `no_browser` arm before the advice.
- [x] 3.4 Run the thin-delta advice before the spawn. At one user turn or less past the anchor, and with no override, return the `existing-session` arm that names the newest child.
- [x] 3.5 Run the spawn with the brief, and pass each refusal through as a typed arm.
- [x] 3.6 Return the thread id and the title on a success. The tool never throws for a degraded condition.
- [x] 3.7 Cover the tool with tests: each arm of the union, the gate order, and the override path.

## 4. The turn assembly

- [x] 4.1 Thread the thread type into `assembleMessages` (`src/app/message-assembly.ts`), from the row that `prepareChatTurn` loads.
- [x] 4.2 Skip the live working-memory tail on a `report` thread. A `conversation` thread keeps it.
- [x] 4.3 Cover the branch with tests: a report turn holds no render, and a conversation turn holds one.

## 5. The roster and the prompt

- [x] 5.1 In `src/agents/conversation-agent.ts`, remove `planReportTool` and `createReportSubmitTool(...)` from the roster. Add the new tool, constructed from `pool` and `chrome`.
- [x] 5.2 Rewrite the "Report Creation" section of `src/prompts/conversation.ts`. It teaches the brief, the steer to the existing report chat, and the no-unprompted-reports rule.
- [x] 5.3 Extend the "Do NOT" list: do not compose a report in the conversation.
- [x] 5.4 Add the roster test: `start_report_session` is present, and neither `plan_report` nor `submit_report` is present.
- [x] 5.5 Add the prompt test: the report section names the new tool, and no brief tool is named.

## 6. The unit of the delta

- [x] 6.1 Add the count of user turns past a seq to `src/memory/thread-history.ts`. It reuses the genuine-user-start predicate.
- [x] 6.2 Change `reportSessionDelta` to give that count in place of the latest seq.
- [x] 6.3 Advise at one turn or less in `src/tools/start-report-session.ts`.
- [x] 6.4 Cover the rule: the ask of the spawn does not clear the advice, a second user turn clears it, and a synthetic record does not.

## 7. The one moment of the spawn

- [x] 7.1 Add the optional anchor dep to `createReportSessionSpawn`. The spawn runs it after the seed lands.
- [x] 7.2 Keep the child on a failed pin, and send the failure to the logger.
- [x] 7.3 Thread the dep from the assembly through `ConversationAgentDeps` and the tool. The embedder supplies nothing.
- [x] 7.4 Bound each brief field in the schema of the tool.
- [x] 7.5 Cover the pin: the spawn pins, a later artifact is no member, and a failed pin keeps the child.

## 8. Verification

- [x] 8.1 Run `tsc -p tsconfig.json` and `bun test` in `harness/`.
- [x] 8.2 Run `bun run format:file` on each changed source file.
- [x] 8.3 Search the prompts and the tool descriptions for a stale name of the old pair, per the agent-facing-copy rule.
