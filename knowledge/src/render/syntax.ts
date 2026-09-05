/**
 * The syntax check of a rendered script. R scripts parse with `Rscript -e
 * parse()`, and Python scripts parse with `ast.parse`. A host without the
 * interpreter reports `unchecked`, never `ok`, thus a reader of the decision
 * record can tell a checked script from an assumed one.
 */

export type SyntaxCheck = { readonly status: "ok" } | { readonly status: "error"; readonly message: string } | { readonly status: "unchecked"; readonly reason: string };

export async function checkRSyntax(script: string): Promise<SyntaxCheck> {
    const rscript = Bun.which("Rscript");
    if (!rscript) return { status: "unchecked", reason: "Rscript is not on the PATH of the service" };
    const path = `${Bun.env.TMPDIR ?? "/tmp"}/inflexa-knowledge-${crypto.randomUUID()}.R`;
    await Bun.write(path, script);
    try {
        const proc = Bun.spawn([rscript, "-e", `invisible(parse(file = commandArgs(trailingOnly = TRUE)[1]))`, path], { stdout: "pipe", stderr: "pipe" });
        const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
        if (code === 0) return { status: "ok" };
        return { status: "error", message: stderr.trim().split("\n").slice(0, 6).join("\n") };
    } finally {
        await Bun.file(path)
            .unlink()
            .catch(() => undefined);
    }
}

export async function checkPythonSyntax(script: string): Promise<SyntaxCheck> {
    const python = Bun.which("python3") ?? Bun.which("python");
    if (!python) return { status: "unchecked", reason: "python3 is not on the PATH of the service" };
    const path = `${Bun.env.TMPDIR ?? "/tmp"}/inflexa-knowledge-${crypto.randomUUID()}.py`;
    await Bun.write(path, script);
    try {
        const proc = Bun.spawn([python, "-c", "import ast, sys\nast.parse(open(sys.argv[1], encoding='utf-8').read(), filename=sys.argv[1])", path], { stdout: "pipe", stderr: "pipe" });
        const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
        if (code === 0) return { status: "ok" };
        return { status: "error", message: stderr.trim().split("\n").slice(-6).join("\n") };
    } finally {
        await Bun.file(path)
            .unlink()
            .catch(() => undefined);
    }
}

/** The checker of a template language. */
export function checkSyntax(language: "R" | "python", script: string): Promise<SyntaxCheck> {
    return language === "R" ? checkRSyntax(script) : checkPythonSyntax(script);
}
