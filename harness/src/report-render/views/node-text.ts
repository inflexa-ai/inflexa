/**
 * The one text boundary of the view markup.
 *
 * The JSX runtime types an element as `HtmlEscapedString | Promise<HtmlEscapedString>`
 * (`JSX.Element` of `hono/jsx`). The promise member cannot render synchronously; every
 * view renders synchronously, so the guard names the member the views never hold, and
 * the string member converts through its own text.
 */
import type { HtmlEscapedString } from "hono/utils/html";

export function stringOfNode(node: HtmlEscapedString | Promise<HtmlEscapedString>): string {
    if (node instanceof Promise) {
        throw new Error("the views render synchronously; an async node has no text here");
    }
    return String(node);
}
