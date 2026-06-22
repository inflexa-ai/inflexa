declare global {
    interface DateConstructor {
        /**
         * Formats the elapsed time since a past millisecond timestamp as a compact,
         * single-unit relative age — the largest whole unit that fits (`6m`, `3h`, `2d`).
         * A static on Date (mirroring `Date.now`) so any "age" readout reads from one
         * place instead of each panel redeclaring the same bucketing. Clamps negatives
         * (a future timestamp / clock skew) to `0s` rather than printing a negative age.
         */
        relativeAge(since: number): string;
    }
}

Date.relativeAge = function (since: number): string {
    const secs = Math.max(0, Math.floor((Date.now() - since) / 1000));
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
};

export {};
