/**
 * Installs `value` as a direct property of `target` and returns the closure
 * that puts the original member back. `Reflect.set` takes `unknown` values, so
 * a monkey-patch install needs no cast on the DBOS globals the tests replace;
 * plain assignment would need one, because the member's declared type is the
 * production one and the test's replacement is a double.
 */
export function installWritable(target: object, name: string, value: unknown): () => void {
    const original: unknown = Reflect.get(target, name);
    Reflect.set(target, name, value);
    return () => {
        Reflect.set(target, name, original);
    };
}
