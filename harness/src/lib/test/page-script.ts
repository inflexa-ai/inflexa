// The report page ships its scripts as bytes: the render assets, the bootstrap,
// and the per-plot builders ride the page as script text, and these tests run
// the exact shipped bytes against a faked page. The three entry points below
// hold the only sanctioned `new Function` of the test rig; every page-script
// test goes through them, so the bytes stay the test's subject.

type PageFn = (...args: never[]) => unknown;

/** Compiles and runs a page script; `F` is the script's own parameter and return contract. */
export function evaluatePageScript<F extends PageFn>(source: string, ...args: Parameters<F>): ReturnType<F> {
    // oxlint-disable-next-line typescript/no-implied-eval,typescript/no-unsafe-call -- the helper evaluates this repo's page-source bytes, because the page runs them as script and the test's subject is the exact shipped bytes
    return new Function(source)(...args);
}

/** Runs a page script against the faked page globals it declares by parameter name. */
export function runPageScript<F extends PageFn>(params: string[], source: string, ...args: Parameters<F>): ReturnType<F>;
export function runPageScript(params: string[], source: string, ...args: unknown[]): void;
export function runPageScript(params: string[], source: string, ...args: unknown[]): unknown {
    // oxlint-disable-next-line typescript/no-implied-eval,typescript/no-unsafe-call -- the helper evaluates this repo's page-source bytes, because the page runs them as script and the test's subject is the exact shipped bytes
    return new Function(...params, source)(...args);
}

/** Compiles a page script to prove it parses, without running it. */
export function compilePageScript(source: string): void {
    // oxlint-disable-next-line typescript/no-implied-eval -- the helper evaluates this repo's page-source bytes, because the page runs them as script and the test's subject is the exact shipped bytes
    new Function(source);
}
