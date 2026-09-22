/**
 * The DBOS serialization recipes of the neverthrow `Ok` and `Err` classes.
 *
 * DBOS saves each workflow input, step output, workflow output, and message
 * with SuperJSON, and SuperJSON drops the class of an object that it does not
 * know. Without these recipes a step that returns a `Result` gives back a plain
 * object with no `Result` methods, on the first run and on each replay alike,
 * because DBOS hands the body the deserialized value. `launchDbos` registers
 * the recipes one time, before DBOS launches.
 *
 * SuperJSON does not walk the output of a custom recipe, thus each recipe
 * encodes the value that it holds as JSON itself. An `Error` inside that value
 * keeps its name and its message only, and a `Result` nested inside the value
 * loses its class. A step that must keep more maps its error to plain data
 * inside the step, before the checkpoint.
 */

import type { SerializationRecipe } from "@dbos-inc/dbos-sdk";
import { Err, Ok, err, ok } from "neverthrow";

export type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };

export type EncodedOk = { value?: Json };

export type EncodedErr = { error?: Json };

/**
 * The JSON form of the value inside a `Result`, with the rules of
 * `JSON.stringify`. An `Error` becomes `{ name, message }`, because
 * `JSON.stringify` gives `{}` for one. A `bigint` becomes its decimal text,
 * because `JSON.stringify` throws on one.
 */
function toJson(value: unknown): Json {
    const text = JSON.stringify(value, (_key, v: unknown) => {
        if (v instanceof Error) return { name: v.name, message: v.message };
        if (typeof v === "bigint") return v.toString();
        return v;
    });
    return text === undefined ? undefined : (JSON.parse(text) as Json);
}

export const okRecipe: SerializationRecipe<Ok<unknown, never>, EncodedOk> = {
    name: "neverthrow.Ok",
    isApplicable: (v): v is Ok<unknown, never> => v instanceof Ok,
    serialize: (v) => ({ value: toJson(v.value) }),
    deserialize: (s) => ok(s.value),
};

export const errRecipe: SerializationRecipe<Err<never, unknown>, EncodedErr> = {
    name: "neverthrow.Err",
    isApplicable: (v): v is Err<never, unknown> => v instanceof Err,
    serialize: (v) => ({ error: toJson(v.error) }),
    deserialize: (s) => err(s.error),
};
