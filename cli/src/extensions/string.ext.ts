declare global {
    interface String {
        /**
         * Compact relative age of THIS string parsed as a serialized date — the string counterpart
         * to {@link DateConstructor.relativeAge}, for the many call sites that hold an ISO timestamp
         * (a ledger `started_at`, a run's `startedAt`) rather than a millisecond number. Returns the
         * same `5m31s`/`8h54m` shape, or `null` when the string does not parse to a date.
         *
         * `null`, deliberately, rather than a placeholder glyph: this is a global with no business
         * knowing the TUI's em-dash vocabulary, so an unparseable/absent value is handed back to the
         * caller to render as it sees fit — the sidebar rail collapses it to an em dash, the run
         * block shows nothing. Keeping the fallback at the call site is what lets a `components/`
         * file (which may not import the hooks-layer `relAge`) share the one parse-then-age path.
         */
        relativeAge(): string | null;
    }
}

String.prototype.relativeAge = function (this: string): string | null {
    const t = Date.parse(this.valueOf());
    return Number.isNaN(t) ? null : Date.relativeAge(t);
};

export {};
