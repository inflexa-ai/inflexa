/**
 * The repair of a tool name that a proxy alias left behind.
 *
 * The Claude cloak of CLIProxyAPI renames each client tool to `mcp__<server>__<word>_<tool>`, and it maps the name
 * back on the response. The model sometimes drops the `mcp__<server>__` part. Then the proxy maps nothing back, and
 * the loop gets `<word>_<tool>`, for example `art_read_file` (router-for-me/CLIProxyAPI#6848, which upstream closed as
 * not planned). A name of one lowercase word, an underscore, and a declared tool id is such an alias. The repair
 * applies only to a name that no tool declares, thus a declared tool always keeps its own name.
 */

/** The declared tool that an alias names, or `undefined` for a name that is not an alias of one. */
export function aliasedToolName(name: string, declared: ReadonlySet<string>): string | undefined {
    if (declared.has(name)) return undefined;
    const split = name.indexOf("_");
    if (split <= 0) return undefined;
    const word = name.slice(0, split);
    const tool = name.slice(split + 1);
    for (const char of word) if (char < "a" || char > "z") return undefined;
    return declared.has(tool) ? tool : undefined;
}
