import { checkChatPart, type ChatFrame, type ChatPartFrame } from "@inflexa-ai/harness/contracts/index.js";

import { getLogger } from "./log.ts";

/**
 * The tail every chat-frame reader shares (the REPL printer's `onFrame`, the TUI store's
 * `applyServerFrame`): a frame that reaches the reader's switch default is either one of the four
 * loop-event kinds that carry no rendered part — `finish`/`error` end the stream and the turn's
 * driver reads the outcome from the stream tail, only a sub-agent gives an `iteration` and the
 * reader's sub-agent routing has already taken each one, and `message-start` names a message no
 * reader keys on — or a `data-*` part, which passes the ONE `checkChatPart` check before the apply
 * hand-off: an invalid part of a known type is dropped with a warning, and a part whose type this
 * build does not know passes unchanged. Returns the result of `apply`, or `undefined` when the frame
 * was a no-op or was dropped, so an async renderer and a synchronous store apply share the one tail.
 */
export function readChatTail<T>(frame: ChatFrame, apply: (part: ChatPartFrame) => T): T | undefined {
    switch (frame.type) {
        case "iteration":
        case "finish":
        case "error":
        case "message-start":
            return undefined;
        default: {
            // The one check of a part: each reader past this point trusts the type of the part.
            const checked = checkChatPart(frame);
            if (!checked.ok) {
                getLogger("chat").warn({ type: frame.type, error: checked.error }, "chat part dropped: it failed the check of its type");
                return undefined;
            }
            return apply(checked.frame);
        }
    }
}
