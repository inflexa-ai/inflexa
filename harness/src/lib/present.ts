/**
 * A positional or keyed read whose construction guarantees presence, replacing
 * a non-null assertion with a failure that names the read. A helper serves only
 * a guaranteed read — a lookup that can miss takes its module's absence path,
 * because a throw there would turn a handled absence into a crash.
 */

function absent(what: string): Error {
    return new Error(`${what} is absent`);
}

export function presentFirst<T>(values: readonly T[], what?: string): T {
    const first = values[0];
    if (first === undefined) throw absent(what ?? "the first element");
    return first;
}

export function presentAt<T>(values: readonly T[], index: number, what?: string): T {
    const value = values[index];
    if (value === undefined) throw absent(what ?? `the element at index ${index}`);
    return value;
}

export function presentLast<T>(values: readonly T[], what?: string): T {
    const last = values[values.length - 1];
    if (last === undefined) throw absent(what ?? "the last element");
    return last;
}

export function presentFind<T>(values: readonly T[], matches: (value: T) => boolean, what?: string): T {
    const found = values.find(matches);
    if (found === undefined) throw absent(what ?? "the matching element");
    return found;
}

export function presentGet<V>(source: Map<string, V> | Readonly<Record<string, V>>, key: string, what?: string): V;
export function presentGet<K, V>(source: Map<K, V>, key: K, what?: string): V;
export function presentGet<V>(source: Map<string, V> | Readonly<Record<string, V>>, key: string, what?: string): V {
    const value = source instanceof Map ? source.get(key) : source[key];
    if (value === undefined) throw absent(what ?? `the entry for "${key}"`);
    return value;
}
