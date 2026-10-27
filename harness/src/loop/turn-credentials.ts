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

import type { LanguageModelMiddleware } from "ai";
import { z } from "zod";

import type { AuthContext } from "../auth/types.js";
import { errorNameOf } from "../lib/thrown.js";

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

/** The error of a model call of a turn whose host gives no credential. The turn pauses on it with the cause `credential`. */
export class TurnCredentialMissingError extends Error {
    constructor() {
        super("The turn has no credential of its user.");
        this.name = "TurnCredentialMissingError";
    }
}

/**
 * A middleware that fails each model call while `credentialOf` gives no credential. It runs inside the step of the
 * call, thus a replay of a recorded call does not read the credential again.
 */
export function credentialGuard(credentialOf: () => AuthContext | undefined): LanguageModelMiddleware {
    const missing = (): boolean => credentialOf() === undefined;
    return {
        specificationVersion: "v4",
        wrapStream: ({ doStream }) => (missing() ? Promise.reject(new TurnCredentialMissingError()) : doStream()),
        wrapGenerate: ({ doGenerate }) => (missing() ? Promise.reject(new TurnCredentialMissingError()) : doGenerate()),
    };
}

/** A link of the chain whose cause is an error. The error of a missing credential is an `Error`, thus the walk follows errors only. */
const CauseLinkSchema = z.looseObject({ cause: z.instanceof(Error) });

/** The depth of a cause chain that the walk reads, as a bound for a chain with a cycle. */
const CAUSE_CHAIN_DEPTH = 8;

/** Whether an error, or an error on its cause chain, is a missing credential of a turn. A replay of a step gives the name again. */
export function isTurnCredentialMissing(err: unknown): boolean {
    let link: unknown = err;
    for (let depth = 0; depth < CAUSE_CHAIN_DEPTH && link !== undefined; depth++) {
        if (errorNameOf(link) === "TurnCredentialMissingError") return true;
        const next = CauseLinkSchema.safeParse(link);
        link = next.success ? next.data.cause : undefined;
    }
    return false;
}
