# The Sandbox Recovery Wedge — what "#28" actually refers to, and the fix space

Written 2026-07-07. Sources: the live observations recorded in
`docs/harness_integration-new/00-progress.md` (§Change D findings, §Change D2 findings),
issue #28 (data-profile kill/resume verification), issue #27 (Linux ingress
reachability), issue #33 (daemon architecture, design notes 2 & 5). The candidate fixes
in §4 are design sketches — each carries its verification questions; none has been
prototyped.

## 1. Disambiguation: two things travel under "#28"

**Issue #28 proper** is narrow and cheap: the data-profile path's kill/resume was never
exercised live (the run path was, successfully — recovery reclaimed the workflow and
completed it under the same run id). The issue body contains a ~2–5 minute closure
procedure. Risk is assessed LOW because both workflow types share the same launch-time
recovery keyed on `executor_id = "local"`. This should simply be executed the next time
a live-E2E window is open — there is nothing to design.

**The recovery wedge** is the hard failure the D/D2 landing notes called "issue #28
class": a run that DBOS recovery *adopts* but that can never make progress. It has no
dedicated issue — #28's final checklist item ("confirm the reaper/watchdog cleaned any
orphaned sandbox container — no accumulation, no deadline-long hang") gestures at the
territory, and #33 design-note-5 names recovery exercising as an interaction, but the
wedge mechanism itself is recorded only in the research folder's findings.
**Recommendation: file it as its own issue** — it is a distinct, reproducible defect
with direct evidence.

## 2. The wedge mechanism (observed live, twice, during D2's E2E)

As recorded in `harness_integration-new/00-progress.md`:

1. A run is executing a sandbox step; the host process is killed (SIGKILL) after a
   sandbox command finishes but **before its completion callback lands**. The callback
   ingress (`cli/src/modules/harness/ingress.ts`) was bound to an **ephemeral port**
   baked into the container's `CORTEX_BASE_URL` at creation — that port died with the
   host.
2. The surviving container's sandbox-server retries the callback against the dead
   port (per #27: retries until the exec deadline).
3. A recovery boot adopts the workflow. `sandbox.create` is a **checkpointed DBOS
   step**, so re-execution *reuses the leaked boot-1 container* rather than creating a
   fresh one — the recovered `DBOS.recv` waits on a completion that will never be
   POSTed anywhere reachable.
4. The run wedges: the sandbox is alive (so the liveness watchdog's dead-sandbox
   synthetic-failure path never fires), the recv never unblocks.

**Manual unwedge, proven live:** remove the leaked container. The next recovery boot
finds no sandbox, creates a fresh one, and the run completes. (Direct evidence from the
D2 kill/recovery test, which additionally proved the provenance layer is robust to this:
multi-boot re-emission still produced exactly one run activity, relation counts all 1.)

## 3. Why this matters more than its frequency suggests

Detach-and-recover is a headline product property — D's landing proved terminal
provenance survives host kill, F proved run resumption, and #33 makes "Ctrl+C genuinely
detaches" the advertised UX. The wedge is the one observed case where recovery adopts a
run it cannot finish, and its failure mode is silent (a `running` run that never
progresses). Once the daemon lands, a daemon crash pauses *all* runs (#33 design-note-5)
— the blast radius of a post-crash wedge grows with exactly the architecture we are
committed to.

## 4. The fix space

Four layers, not alternatives — they compose. Ordered by how much of the problem each
removes.

### 4a. Prevention: stable ingress port (this is #33 M2, not new work)

#33 design-note-2 already commits to it: a long-lived daemon binds a **fixed,
configurable callback port**, so a rebooted host listens exactly where surviving
sandboxes are already retrying. The wedge window shrinks from "any host restart
mid-exec" to "callback retry gave up before the daemon came back" (per #27, sandbox-
server retries until the exec deadline — default 300s from `DEFAULT_DEADLINE_MS`).
Interacts with #27's bridge-gateway bind on Linux; the two should be designed together
(same conclusion as #33).

*What it does not cover:* recoveries that happen after the retry deadline expires, and
the pre-daemon embedded topology entirely (every boot gets a fresh ephemeral port
today).

### 4b. Detection: widen the watchdog's liveness semantics

Today's scheduled watchdog asks `SandboxClient.isAlive(sandboxRef)` and synthesizes a
failure-complete only for dead sandboxes — the wedged container is healthy, so it is
invisible. The sketch: a sandbox whose baked callback target no longer points at the
live ingress is *effectively dead* for protocol purposes → tear it down (or synthesize
the failure directly), letting the existing recovery machinery re-run the step against
a fresh sandbox.

*Verification questions before speccing:* can the watchdog cheaply learn a container's
baked `CORTEX_BASE_URL` (Docker: env inspection; K8s: pod spec) and the current ingress
address for comparison? Does tearing down a sandbox mid-recv reliably trigger the
existing synthetic-failure → step-retry path, and is the step body idempotent enough to
re-run (it is designed to be — DBOS re-executes step bodies by contract)? This is the
smallest **pre-daemon stopgap** if one is wanted, and stays useful post-daemon as the
after-deadline backstop 4a leaves open.

### 4c. Reconciliation: pull completion state instead of waiting for the push

The protocol is push-only (sandbox POSTs `/complete`; host `DBOS.recv`s). A recovery
boot could *ask* the sandbox for the exec's outcome instead of waiting: either a status
endpoint on sandbox-server, or leaning on the submit idempotency (`POST /exec` is
idempotency-keyed on execId — what does re-submitting a completed execId return today?
Unverified). If re-submit returns or re-fires the completion, recovery self-heals with
no watchdog involvement and no container teardown.

*Verification questions:* sandbox-server's actual idempotent-resubmit semantics
(`images/sandbox-base/server/`); whether the completion payload (including the
provenance frame) is retained after the first POST attempt fails or is dropped after
the retry deadline. This is the most surgical fix but touches the Go server and the
protocol spec (`harness-sandbox-exec`).

### 4d. Manual: document the proven unwedge

Whatever else happens, the operator move ("remove the leaked container; reboot the
runtime") is proven and should live in a debugging doc / the future issue rather than
only in a research tracker.

## 5. Recommendation

Do not build a standalone wedge change now. The durable fix (4a) is already a committed
deliverable of #33 M2, and the detection/reconciliation layers (4b/4c) should be
designed against the daemon's fixed-port topology, not the ephemeral-port one about to
be retired. Concretely:

1. **File the wedge issue** (mechanism + evidence + manual unwedge from §2, fix space
   from §4) so it stops living in a research tracker. Link it from #33 (design-note-5)
   and #27.
2. **Close #28 proper** at the next live-E2E opportunity — it is a 5-minute procedure
   with the steps already written.
3. **Fold 4b-vs-4c** into #33 M2's design as the "recovery after retry-deadline"
   question, with the §4 verification questions as the checklist. If M2 is far off and
   a wedge recurs in real use, 4b is the stopgap to spec first.

## 6. Open questions

- [ ] Does sandbox-server drop or retain the completion payload once its retry deadline
      lapses? (Decides whether 4c is even possible after long outages.)
- [ ] What exactly does idempotent re-submit of a completed execId return? (Decides
      4c's shape: status read vs re-fire.)
- [ ] Frequency in practice: both observations were induced by SIGKILL during E2E.
      Does the wedge also arise from ordinary crashes/OOM of the host process? (Bears
      on whether a pre-daemon stopgap is worth building at all.)
