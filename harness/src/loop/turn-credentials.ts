/**
 * The live credential of each chat turn of this process.
 *
 * A chat turn stores no credential in its workflow. The open of a turn puts the
 * credential of the request here, and the end of the turn takes it away. A turn
 * that a recovery runs in a new process finds no entry, thus the function of
 * the host gives its credential, or nothing. A sub-agent of a turn asks for the
 * credential of its root turn, which it knows from the context of its body.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { AuthContext } from "../auth/types.js";

const credentials = new Map<string, AuthContext>();
let hostCredential: ((turnId: string) => AuthContext | undefined) | undefined;
const rootTurn = new AsyncLocalStorage<string>();

export const turnCredentials = {
    put(turnId: string, auth: AuthContext): void {
        credentials.set(turnId, auth);
    },
    drop(turnId: string): void {
        credentials.delete(turnId);
    },
    /** The credential of a turn: the live one of this process, else the one that the function of the host gives. */
    of(turnId: string): AuthContext | undefined {
        return credentials.get(turnId) ?? hostCredential?.(turnId);
    },
    /** The function of the host for a turn that this process did not open. */
    setHostCredential(credentialFor: ((turnId: string) => AuthContext | undefined) | undefined): void {
        hostCredential = credentialFor;
    },
};

/** Run the body of a turn, or of one of its sub-agents, with the id of its root turn in its context. */
export function withRootTurn<T>(turnId: string, body: () => Promise<T>): Promise<T> {
    return rootTurn.run(turnId, body);
}

/** The id of the root chat turn of the body that runs, or `undefined` outside a chat turn. */
export function currentRootTurn(): string | undefined {
    return rootTurn.getStore();
}
