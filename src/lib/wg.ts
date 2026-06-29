/**
 * A lightweight concurrency barrier modelled after Go's `sync.WaitGroup`: collect async work with
 * {@link go}/{@link goMany}, then {@link wait} for all of it to settle. Failures are swallowed
 * (`allSettled`) — callers handle errors inside their work functions, not at the barrier.
 */
export class WaitGroup {
    constructor() {}

    private work: Promise<unknown>[] = [];

    /** Track a single in-flight promise. */
    public go(p: Promise<unknown>) {
        this.work.push(p);
    }

    /** Fan out `workFn` over every item, tracking each returned promise. */
    public goMany<T>(items: T[], workFn: (item: T) => Promise<unknown>) {
        for (const item of items) {
            this.work.push(workFn(item));
        }
    }

    /** Block until every tracked promise settles (resolve or reject). Drains the internal list so the group is reusable. */
    public async wait(): Promise<void> {
        if (this.work.length === 0) return;

        const work = this.work;
        this.work = [];

        void (await Promise.allSettled(work));
    }
}
