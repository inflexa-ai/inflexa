// Serialization for durable writes to one conversation thread.
//
// The harness's thread store assumes a SINGLE WRITER per thread — `appendTurn` stamps a monotonic
// per-thread `seq`, and `retractLastTurn` cuts at the last genuine-user-start row — and it says so
// explicitly: turn ordering is the host's responsibility. Until now the host had exactly one KIND of
// writer (a chat turn), so the assumption held for free. A run's outcome record is a second, and a
// record appended into the middle of an unwinding turn would splice a message between that turn's
// rows.
//
// This is deliberately NOT the conversation store's generation token. That token's whole purpose is
// that the newest UI operation wins and older ones are silently DROPPED — correct for a transcript
// load superseded by a session swap, where the dropped work was about to be thrown away anyway. It
// is exactly wrong here: a user's message and a run's outcome are both durable, both were genuinely
// requested, and neither may be discarded in favour of the other. What is needed is a queue.
//
// The relation is ASYMMETRIC, and deliberately so — the two writers are not peers:
//
//   - A RECORD waits for every in-flight turn and every earlier record. A turn's own `appendTurn`
//     lands inside `runChatTurn`, at the very end, so nothing short of the whole turn is a safe
//     window. This is the "defer until the turn's append has completed" rule, and it costs the
//     reader nothing: the transient toast already fired, and a completion record is not
//     time-critical.
//
//   - A TURN waits only for pending RECORDS, never for another turn. Ordering BETWEEN turns is an
//     existing concern with an existing answer (the conversation store's generation token and the
//     per-turn abort token, which together drop a superseded turn's UI effects); making turns queue
//     on each other would change chat behaviour this change has no business changing. And when no
//     record is pending — the overwhelmingly common case — the turn's body is invoked
//     SYNCHRONOUSLY, because `send` is relied upon to arm its hot state (assistant id, abort
//     controller, busy status) before its first await returns.
//
// NOT every thread write passes through here, and the exclusion is deliberate. `runDurableRetract`
// (`conversation.ts`) removes a thread's tail turn OUTSIDE this lock, and it must: it is the tail of
// an abort the user just triggered, the comment at its call site explains why the durable removal is
// awaited before any visible transition, and putting a queue wait in front of it would add a record
// append's latency to the one path whose whole design is that the user sees a single instant
// transition. `healTailOrphan` runs inside `send`, so it is already covered by the turn's own hold.
//
// What that admits: a record admitted before a retract, but landing after its cut, attaches to the
// turn that is now the tail rather than the one it followed. Bounded and survivable — `seq` stays
// monotonic, no row is lost or duplicated, and the harm is one outcome record reading as though it
// arrived a turn earlier than it did. The alternative trades a visible, immediate interaction cost
// for an invisible ordering nicety in a case that needs two durable writes to race a keystroke.

/** Every in-flight turn per thread. A barrier records wait behind — NOT a queue turns wait on. */
const turns = new Map<string, Set<Promise<unknown>>>();

/** The tail of each thread's record chain. An entry exists only while that thread has a record queued. */
const records = new Map<string, Promise<unknown>>();

/** Register `p` as an in-flight turn on `threadId` until it settles, however it settles. */
function trackTurn(threadId: string, p: Promise<unknown>): void {
    const set = turns.get(threadId) ?? new Set();
    turns.set(threadId, set);
    const guarded = p.catch(() => {});
    set.add(guarded);
    void guarded.then(() => {
        set.delete(guarded);
        if (set.size === 0 && turns.get(threadId) === set) turns.delete(threadId);
    });
}

/**
 * Run a chat turn's body, holding the thread against run-outcome records for its whole duration.
 *
 * Starts `fn` SYNCHRONOUSLY when no record append is pending — the common case, and load-bearing:
 * callers rely on `send` having armed its turn-scoped hot state by the time it first yields. Only a
 * genuinely contended thread defers it, and only by one short INSERT.
 */
export function runTurnWrite<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const pending = records.get(threadId);
    const mine = pending ? pending.then(fn) : fn();
    trackTurn(threadId, mine);
    return mine;
}

/**
 * Append a run-outcome record once every in-flight turn and every earlier record on `threadId` has
 * settled. Admission order is call order among records — this is a queue, not a race, and nothing is
 * dropped.
 *
 * A rejecting or throwing `fn` does not wedge the chain: the successor links onto a guarded copy, so
 * one failed write cannot strand every later one behind it. The rejection still propagates to `fn`'s
 * own caller.
 */
export function withThreadWriteLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    // Snapshot the in-flight turns now: a turn that STARTS after this record was admitted is not one
    // this record must wait for — it will wait for the record instead, which is the same ordering
    // read from the other side.
    const blockers: Promise<unknown>[] = [...(turns.get(threadId) ?? [])];
    const prevRecord = records.get(threadId);
    if (prevRecord) blockers.push(prevRecord);

    const mine = (blockers.length > 0 ? Promise.all(blockers) : Promise.resolve()).then(fn);
    const guarded = mine.catch(() => {});
    records.set(threadId, guarded);
    // Drop the entry once this link is the tail and has drained, so the map holds only threads with
    // live work rather than one entry per thread ever written to in this process.
    void guarded.then(() => {
        if (records.get(threadId) === guarded) records.delete(threadId);
    });
    return mine;
}

/** Whether a run-outcome record is currently queued or running for this thread. */
export function threadRecordPending(threadId: string): boolean {
    return records.has(threadId);
}

/** Test hook: forget every chain and every tracked turn, so one test's pending write never orders another's. */
export function __resetThreadWriteLocksForTest(): void {
    turns.clear();
    records.clear();
}
