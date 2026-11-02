/** Wait until `done` holds, or about one second passes. The assertion after the wait reports a condition that never held. */
export async function until(done: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
}
