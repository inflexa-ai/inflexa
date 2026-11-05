import type { TextareaRenderable } from "@opentui/core";

/**
 * Subscribe the focused/blurred pair that drives an editor's internal focus signal and its host's
 * `onFocusChange`. The subscriptions are imperative opentui event registrations, not a Solid tracked
 * scope: the reads fire at focus/blur time (staying current), so no reactive dependency is dropped.
 * Call it from the editor's INLINE ref callback — a named `ref={handleRef}` reads as a reactive
 * variable used in JSX, which solid/reactivity flags — and pass `onFocusChange` through a getter, so
 * its read fires at event time too.
 */
export function trackEditorFocus(
    r: TextareaRenderable,
    setFocused: (focused: boolean) => void,
    onFocusChange: () => ((focused: boolean) => void) | undefined,
): void {
    r.on("focused", () => {
        setFocused(true);
        onFocusChange()?.(true);
    });
    r.on("blurred", () => {
        setFocused(false);
        onFocusChange()?.(false);
    });
}
