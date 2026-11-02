/** The per-source outcome of one multi-source tool result, found by the source name. */
export function outcome(
    perSource: { source: string; status: string; detail?: string }[],
    source: string,
): { source: string; status: string; detail?: string } | undefined {
    return perSource.find((s) => s.source === source);
}

/** The strict form: the test names a source it needs, thus an absent outcome is a test failure. */
export function outcomeOf(
    perSource: { source: string; status: string; detail?: string }[],
    source: string,
): { source: string; status: string; detail?: string } {
    const reported = outcome(perSource, source);
    if (reported === undefined) throw new Error(`the ${source} outcome is absent`);
    return reported;
}
