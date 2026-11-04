/** An environment object: `process.env` or `Bun.env`. The caller passes it, so this file reads neither. */
export type EnvVars = Record<string, string | undefined>;

/**
 * Remove the variable `name` from `env`. Assigning `undefined` to `process.env` stores the text
 * `"undefined"`, so the variable must be deleted.
 */
export function unsetEnvVar(env: EnvVars, name: string): void {
    // oxlint-disable-next-line typescript/no-dynamic-delete -- `env[name] = undefined` stores the text "undefined" in `process.env`, so only `delete` unsets a variable
    delete env[name];
}

/**
 * Save the named variables of `env` and unset them, to isolate a test from the real environment.
 * Call the returned function to put each saved value back, and to unset the variable that was absent.
 */
export function clearEnvVars(env: EnvVars, names: readonly string[]): () => void {
    const saved = names.map((name): [string, string | undefined] => [name, env[name]]);
    for (const name of names) unsetEnvVar(env, name);
    return () => {
        for (const [name, value] of saved) {
            if (value === undefined) unsetEnvVar(env, name);
            else env[name] = value;
        }
    };
}
