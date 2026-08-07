/**
 * The one script sink helper.
 *
 * The markup runtime escapes each child and each attribute value. A `<script>` sink is the exception,
 * because the JSON inside it goes to the page through `raw()`, and `raw()` adds no protection. Thus this
 * helper is the sole guard of the two JSON sinks.
 *
 * A `</script` sequence inside a data cell can close the element too soon. The helper serializes the value,
 * then it replaces every `<` with `<`. The replacement makes a `</script` sequence unrepresentable,
 * and the JSON value stays identical, because the browser reads `<` as `<`.
 */

/** Serialize a value to JSON that is safe inside a `<script>` element. */
export function scriptJson(value: unknown): string {
    return JSON.stringify(value).replace(/</g, "\\u003c");
}
