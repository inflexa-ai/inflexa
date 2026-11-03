/**
 * An `AsyncGenerator` that yields each item of `items` in order and then ends, for a test double of a
 * stream whose consumer type is `AsyncGenerator` (a chat turn, a conversation read).
 */
// oxlint-disable-next-line typescript/require-await -- an AsyncGenerator over a fixed list has nothing to await, and the consumer types require an AsyncGenerator
export async function* streamOf<T>(items: Iterable<T>): AsyncGenerator<T> {
    yield* items;
}
