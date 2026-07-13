declare global {
    interface DateConstructor {
        /**
         * Formats the elapsed time since a past millisecond timestamp as a compact relative age.
         * Below a minute it is a single seconds unit (`31s`); from a minute up it is the largest
         * whole unit PLUS the next one down, the second zero-padded to two digits so the width is
         * stable (`5m31s`, `8h54m`, `2d04h` — matching {@link formatDuration}'s `2m05s` shape). The
         * second unit is the point: a lone coarse unit like `8h` hides up to an hour of drift, so the
         * next unit down keeps the readout honest without spending a full timestamp. A static on Date
         * (mirroring `Date.now`) so any "age" readout reads from one place instead of each panel
         * redeclaring the same bucketing. Clamps negatives (a future timestamp / clock skew) to `0s`
         * rather than printing a negative age.
         */
        relativeAge(since: number): string;
        /**
         * Formats a duration (a span in milliseconds, not a timestamp) as one compact human
         * string, so every "how long did this take" readout — tool calls, reasoning, turns —
         * speaks a single vocabulary instead of each block picking its own thresholds. Three
         * ranges by magnitude: sub-second stays in whole milliseconds (`14ms`); under a minute
         * shows one decimal second (`1.4s`, `59.9s`) so short spans keep useful precision;
         * a minute or more switches to minutes + zero-padded seconds with no spaces (`1m00s`,
         * `2m05s`, `72m10s`) — large values stay in minutes rather than gaining an hours unit,
         * since durations here are agent-turn-scale, not wall-clock ages. Clamps negatives
         * (clock skew) to `0ms`.
         */
        formatDuration(ms: number): string;
    }
}

Date.relativeAge = function (since: number): string {
    const secs = Math.max(0, Math.floor((Date.now() - since) / 1000));
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m${(secs % 60).toString().padStart(2, "0")}s`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h${(mins % 60).toString().padStart(2, "0")}m`;
    return `${Math.floor(hours / 24)}d${(hours % 24).toString().padStart(2, "0")}h`;
};

Date.formatDuration = function (ms: number): string {
    const clamped = Math.max(0, ms);
    if (clamped < 1000) return `${Math.round(clamped)}ms`;
    if (clamped < 60_000) return `${(clamped / 1000).toFixed(1)}s`;
    const totalSecs = Math.floor(clamped / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins}m${secs.toString().padStart(2, "0")}s`;
};

export {};
