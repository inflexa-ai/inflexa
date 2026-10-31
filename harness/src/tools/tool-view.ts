/**
 * The view of a tool: what a call of the tool shows to a host.
 *
 * A tool declares a `ToolCallView`, or `"none"`, in `defineTool`. A member gives the value to show, and the emit site of
 * the loop (`loop/tool-value.ts`) cleans it: control characters out, each listed secret form out, then the cap. A member
 * gives a string for a `text` value, any other plain value for a `json` value, or the result of one of the helpers
 * below for a value of a kind that the author chooses.
 */

/*
 * Each helper returns an instance of one of these classes, and the emit site tests the class with `instanceof`. A tool
 * result with a field named `kind` is a plain object, thus it is never read as a kind. The constructors stay out of the
 * public barrel, thus only the helpers make an instance.
 */

export class ViewText {
    readonly kind = "text";
    constructor(readonly text: string) {}
}

export class ViewJson {
    readonly kind = "json";
    constructor(readonly value: unknown) {}
}

export class ViewCode {
    readonly kind = "code";
    constructor(
        readonly language: string,
        readonly text: string,
    ) {}
}

/** A value of one kind that holds no other value. */
export type ViewLeaf = ViewText | ViewJson | ViewCode;

export class ViewFields {
    readonly kind = "fields";
    constructor(readonly fields: ReadonlyArray<{ readonly name: string; readonly leaf: ViewLeaf }>) {}
}

export type ViewValue = ViewLeaf | ViewFields;

/**
 * What a tool shows of its calls. Each member is synchronous and pure, and it never reaches the model. A member that is
 * absent shows nothing. A member that throws, or that gives a value that breaks a rule of the kinds, shows nothing, and
 * the call runs as before.
 */
export type ToolCallView<Input, Output> = {
    // `input` and `result` use method syntax, as `describeCall` does on a packaged tool: a method parameter is bivariant, thus a `Tool<Input, Output>` stays assignable to the `Tool` of a registry.
    /** The shown input. It reads the input after the parse with the input schema of the tool. */
    input?(input: Input): unknown;
    /** The shown result of a call that ended `ok`. It reads the ok value that the tool returned. */
    result?(input: Input, result: Output): unknown;
    /** Show the error text of a call that ended `error`. */
    readonly error?: true;
};

/** A plain text. */
export function viewText(text: string): ViewText {
    return new ViewText(text);
}

/** The JSON text of a value. A string shows as a JSON string, with its quotes. */
export function viewJson(value: unknown): ViewJson {
    return new ViewJson(value);
}

/** Source code. `language` has 1 to 20 characters of lowercase letters, digits, `+`, `#`, `.`, and `-`. */
export function viewCode(language: string, text: string): ViewCode {
    return new ViewCode(language, text);
}

/**
 * An ordered list of named values, at most 4. A name has 1 to 40 characters of letters, digits, `_`, and `-`. A field
 * whose leaf is `undefined` is left out. The order is the order of the keys, except that a name made of digits only
 * goes first, as a JavaScript object orders such a key.
 */
export function viewFields(leaves: Readonly<Record<string, ViewLeaf | undefined>>): ViewFields {
    const fields: Array<{ name: string; leaf: ViewLeaf }> = [];
    for (const [name, leaf] of Object.entries(leaves)) {
        if (leaf !== undefined) fields.push({ name, leaf });
    }
    return new ViewFields(fields);
}
