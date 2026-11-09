# Design

## Context

The loop now calls the `approval` hook of a tool before `execute`. It asks the user through the gateway, and on a denial it does not call `execute` and it ends the series (`harness/src/loop/run-loop.ts:827-893`). The gateway keys a standing grant on `grantKey ?? command` (`harness/src/tools/approval/gateway.ts:80-83`). `manage_inputs` and `run_inflexa` already moved to this hook (commit `67980449`). See proposal.md for the reason of the change.

The per-session queue of the tool serializes `execute` alone. The loop calls the `approval` hook outside that queue.

## Goals / Non-Goals

**Goals:**

- Each ask of the tool comes from the `approval` hook, with the same text that the user saw before.
- A call never runs under an approval that the user did not give for the current state of the session.

**Non-Goals:**

- No new harness hook for a denial, and no harness change.
- No idle timeout of a session. The `stop` operation, a completed commit, and the exit sweep of the host end a session, as today.

## Decisions

### One decision function for the two hooks

A pure function takes the session table entry and the input, and gives the ask of the call: none, start, plan, command, or commit. For each ask that is not none, it gives a request key. The `approval` hook renders the request from that decision. `execute` calls the same function inside the queue of the session.

Alternative: keep the logic in `execute` and copy the conditions into the hook. Two copies can disagree, and the stale-approval guard then has nothing to compare.

### The approval records its decision per call

The `approval` hook records the request key of its decision (or "none") in the session entry, under the `invocationId` of the call. `execute` takes that record and computes the decision again. A mismatch, or a missing record for a call that needs an ask, gives a `approval_stale` result, and the call runs nothing. The record lives on the session entry, thus it goes away with the session.

Alternative: an `execute` that only re-derives, with no record. `execute` then cannot know if an exploration read got no ask before the plan bound. The record is the smallest state that answers that question.

A `start` has no session entry before it runs, and its decision depends on the input alone. Thus a start needs no record.

### One ask for the plan and its command

The loop gives one approval to each call. The ask of a call with a new or changed plan holds the plan and the command, with the root mark. The title and the plan text stay as today, and the command line moves into the detail.

### The grant keys

- A plain build command: `install_from_source:<sessionId>`, as today.
- A plan ask: `install_from_source:<sessionId>:plan:<digest>`. The digest is a sha256 over the plan, the command, and the root mark.
- A commit ask: `install_from_source:<sessionId>:commit:<digest>`. The digest is a sha256 over the script, the package directory, and the hosts and apt packages of the plan. The ask shows the plan, and the clean run uses it.
- A start ask: no grant key. The command text names the source, as today.

Thus no answer to one kind of ask approves a different kind, and no plan or commit answer approves different content.

### A denial runs nothing

The tool never sees a denial. The session stays in its phase, and the tool description tells the agent that a denied call ran nothing and left the session open. A rejection with feedback thus steers the agent and keeps the work of the session.

### The context type

The hook takes the inferred context type of `defineTool`. The harness barrel does not export `ToolApprovalContext`, and the tool reads only `invocationId` from it. Thus the harness needs no new export.

## Risks / Trade-offs

- [A denied call leaves a held container] → The agent stops the session on the next turn. The exit sweep of the host removes each container. The cost is memory and process slots, not a store change and not a wider egress.
- [A record stays for a denied call] → The record sits on the session entry and goes away with the session. Its size is one short string for each denied call.
- [A command approval does not bind the plan] → An amendment of a parallel call can restart the session before an approved plain command runs. The user approved the wider list in that plan ask, and the command ask shows no host list. Thus the command runs under the amended list, as an `always` answer also permits.
- [A plan answer of `always` acts as `once`] → The digest makes each plan ask unique. The user answers `always` on a later plain command to stop the command asks.
- [A recovered turn calls the hook again after a host restart] → The session table is empty after a restart. Thus the hook gives no ask, and `execute` answers `unknown_session`, as today.
