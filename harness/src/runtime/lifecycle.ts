/**
 * Process-wide lifecycle flags shared between the readiness probe and the
 * shutdown sequence.
 *
 * `draining` flips true the moment SIGTERM/SIGINT is received, so the
 * readiness probe drops the pod out of LB rotation before the HTTP
 * server starts refusing requests.
 */

let draining = false;

export function isDraining(): boolean {
    return draining;
}

export function markDraining(): void {
    draining = true;
}

/** Test hook — reset the flag between tests. */
export function __resetLifecycleForTest(): void {
    draining = false;
}
