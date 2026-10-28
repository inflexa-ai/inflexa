# Design: reference-the-run-credential

## Context

Nexus splits a mandate (a persisted delegation with a 7-day window that the subject renews) from a mandate token (a JWT that lives 10 minutes). The actor gets tokens with its service identity only. The harness is host-agnostic, thus it names no mandate token; it gives the host the moments where the work pauses for a person and where a person resumes it.

## Goals / Non-Goals

**Goals:**
- A workflow input holds no time-bound credential.
- A person who resumes paused work renews the run credential, and the host can refuse.

**Non-Goals:**
- A credential cache in the harness. The host resolves its reference where it calls its host.
- A renewal of a turn. A turn takes the credential of the person at the resume already.

## Decisions

### The work that holds a mandate ends it
The work that holds a run mandate ends it, whoever made the mandate. A realization that makes a mandate from a passport owns it. A realization that gets a mandate from its caller owns it too. Thus the terminal path of the work always calls `revoke`, and a realization with no mandate, for example the local authorizer, does nothing in `revoke`. `RunAuthorization` and its `ownsMandate` go away: `authorize` gives the `RunSession`, and `revoke` takes it.

### `revoke`, `suspend`, and `renew` take the run session
A step of a run and a sub-agent of a run hold no authorization. Each can build the run session, thus the methods take it.

### Suspend only for a wait that a person ends
A wait in `retrying` ends on its timer. A suspended credential would fail the retry, and no person would come to renew it. Thus only the state `paused` suspends, in a durable step, so a recovery does not suspend again.

### The pause row keeps the run session
A resume names the work, not its workflows, and the run session of a run is only in the inputs of its workflows. The row is written before the wait, so the resume reads the session from the row. A run session is JSON by contract, and it holds a reference, not a secret. The `auth` stays opaque: the row parser checks only that it is a JSON object.

### One renewal for each work
Each waiting workflow of one work holds the same credential, thus the resume renews one time and then sends one message to each workflow.

## Risks / Trade-offs

- [A member who did not start a run resumes it] → The host can refuse the renewal. Nexus refuses a renewal by anyone but the subject, so only the person who started a run can resume it. The resume then answers `refused`, and the work stays paused.
- [A workflow input from an earlier version carries `ownsMandate`] → DBOS gives the stored input to the body with no schema parse, thus the body ignores the extra field. A run that got its mandate from its caller then revokes that mandate at its end, as the decision above states.
- [A failed suspend] → The suspend is a notice. The work waits whatever the outcome, and the window of the credential still bounds it.
