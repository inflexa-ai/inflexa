/**
 * The size of the JSON text of a value, measured with no copy of the value and no text.
 *
 * A caller that hands a value to `JSON.stringify` somewhere it cannot bound, for example the bridge into the VM of a
 * script, measures it first. The walk counts the characters that `JSON.stringify` would write, except the escapes of
 * a string, and it stops at the first character past the limit. Thus a value of gigabytes costs a walk up to the
 * limit, and never a text. The walk keeps one iterator for each open object, thus its memory grows with the depth of
 * the value, and a deep value does not overflow the call stack.
 */

/** The measure of a value: its size within the limit, a size past the limit, or the reason that JSON cannot carry it. */
export type JsonSize =
    | { readonly kind: "within"; readonly chars: number }
    | { readonly kind: "over"; readonly limit: number }
    | { readonly kind: "unserializable"; readonly detail: string };

/** One child of an object or an array: its value, the characters before it (a key and a comma), and whether an array holds it. */
type Child = { readonly node: unknown; readonly prefix: number; readonly inArray: boolean };

/** The children of an array or an object, in the order that `JSON.stringify` writes them. */
function* childrenOf(object: object): Generator<Child> {
    if (Array.isArray(object)) {
        for (const [index, item] of object.entries()) yield { node: item, prefix: index > 0 ? 1 : 0, inArray: true };
        return;
    }
    let fields = 0;
    for (const [key, field] of Object.entries(object)) {
        if (field === undefined || typeof field === "function" || typeof field === "symbol") continue;
        yield { node: field, prefix: key.length + 3 + (fields > 0 ? 1 : 0), inArray: false };
        fields += 1;
    }
}

/** The characters of a value with no children. `inArray` writes a value with no JSON form as `null`. */
function leafChars(node: unknown, inArray: boolean): number {
    switch (typeof node) {
        case "string":
            return node.length + 2;
        case "number":
            return Number.isFinite(node) ? String(node).length : 4;
        case "boolean":
            return node ? 4 : 5;
        case "undefined":
        case "function":
        case "symbol":
            return inArray ? 4 : 0;
        default:
            return 4;
    }
}

/**
 * The value as an object or an array, or `undefined` for a primitive and a function. The walk measures any value,
 * not a known shape, thus no schema describes it. `new Object(value)` gives the value itself only for an object.
 */
function objectOf(value: unknown): object | undefined {
    if (typeof value === "function") return undefined;
    const boxed: object = new Object(value);
    return boxed === value ? boxed : undefined;
}

/** Measure the JSON text of `value` against `limit` characters. */
export function measureJson(value: unknown, limit: number): JsonSize {
    let chars = 0;
    const open: Array<{ readonly object: object; readonly children: Generator<Child> }> = [];
    const ancestors = new Set<object>();
    let next: Child | undefined = { node: value, prefix: 0, inArray: false };
    while (next !== undefined) {
        let { node } = next;
        chars += next.prefix;
        if (typeof node === "bigint") return { kind: "unserializable", detail: "a bigint has no JSON form" };
        for (let object = objectOf(node); object !== undefined; object = objectOf(node)) {
            const toJSON: unknown = Reflect.get(object, "toJSON");
            if (typeof toJSON !== "function") break;
            const json: unknown = Reflect.apply(toJSON, object, []);
            node = json;
        }
        const object = objectOf(node);
        if (object === undefined) {
            chars += leafChars(node, next.inArray);
        } else {
            if (ancestors.has(object)) return { kind: "unserializable", detail: "the value holds a cycle" };
            ancestors.add(object);
            open.push({ object, children: childrenOf(object) });
            chars += 2;
        }
        if (chars > limit) return { kind: "over", limit };
        next = undefined;
        while (next === undefined && open.length > 0) {
            const top = open[open.length - 1];
            const child = top?.children.next();
            if (top !== undefined && child?.done === false) {
                next = child.value;
            } else if (top !== undefined) {
                ancestors.delete(top.object);
                open.pop();
            }
        }
    }
    return { kind: "within", chars };
}
