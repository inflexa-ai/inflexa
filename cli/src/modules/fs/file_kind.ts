import * as linguist from "linguist-languages";
import type { Language } from "linguist-languages";

import type { FileKind } from "../../api/fs.ts";

/** The kind and the highlighter language of a file. A language is an id of {@link HIGHLIGHT_LANGUAGES}, or `text`. */
type FileType = { kind: FileKind; language: string };

/**
 * The only map of the server from a file to its kind and its language: `[kind, language, extensions, names]`. A name
 * matches the whole file name, for a file with no useful extension. The highlighter has no grammar for WDL, thus it is `text`.
 * A Snakefile is Python with rules, and a CWL file is YAML. A TIFF file is `data`, not `figure`, because a browser does not show it. `m` is MATLAB, `pl` and `t` are Perl, `mod` is NMODL or NONMEM, `pro` is IDL, and `cls` is LaTeX, the readings of an analyst. `mod`, `pro`, and `v` are `text`, because the highlighter has no grammar for the reading of an analyst.
 */
const FILE_TYPES: readonly (readonly [FileKind, string, readonly string[], (readonly string[])?])[] = [
    ["table", "text", ["xlsx", "xls", "parquet"]],
    ["table", "csv", ["csv"]],
    ["table", "tsv", ["tsv", "tab"]],
    ["figure", "text", ["png", "jpg", "jpeg", "gif", "webp"]],
    ["figure", "xml", ["svg"]],
    ["code", "python", ["py", "smk"], ["snakefile"]],
    ["code", "r", ["r"]],
    ["code", "json", ["ipynb"]],
    ["code", "bash", ["sh", "bash", "zsh", "sbatch", "slurm"]],
    ["code", "awk", ["awk"]],
    ["code", "perl", ["pl", "pm", "t"]],
    ["code", "julia", ["jl"]],
    ["code", "matlab", ["m"]],
    ["code", "sql", ["sql"]],
    ["code", "nextflow", ["nf"], ["nextflow.config"]],
    ["code", "groovy", ["groovy"]],
    ["code", "text", ["wdl", "mod", "pro", "v"]],
    ["code", "yaml", ["cwl", "yaml", "yml"]],
    ["code", "stata", ["do"]],
    ["code", "sas", ["sas"]],
    ["code", "jinja", ["j2", "jinja"]],
    ["code", "make", ["mk"], ["makefile"]],
    ["code", "docker", [], ["dockerfile", "containerfile"]],
    ["code", "toml", ["toml"]],
    ["code", "ini", ["ini", "cfg"]],
    ["code", "dotenv", [], [".env"]],
    ["code", "gnuplot", ["gp"]],
    ["code", "c", ["c", "h"]],
    ["code", "cpp", ["cpp", "cc", "hpp"]],
    ["code", "rust", ["rs"]],
    ["code", "go", ["go"]],
    ["code", "java", ["java"]],
    ["code", "javascript", ["js", "mjs", "cjs"]],
    ["code", "jsx", ["jsx"]],
    ["code", "typescript", ["ts", "mts", "cts"]],
    ["code", "tsx", ["tsx"]],
    ["code", "fortran-fixed-form", ["f"]],
    ["code", "fortran-free-form", ["f90"]],
    ["code", "diff", ["diff", "patch"]],
    ["log", "log", ["log"]],
    ["data", "json", ["json"]],
    ["data", "jsonl", ["jsonl"]],
    ["data", "xml", ["xml"]],
    [
        "data",
        "text",
        [
            "h5ad",
            "h5",
            "hdf5",
            "loom",
            "rds",
            "rdata",
            "rda",
            "npy",
            "npz",
            "pkl",
            "feather",
            "mtx",
            "bam",
            "sam",
            "cram",
            "bai",
            "vcf",
            "bcf",
            "bed",
            "gff",
            "gff3",
            "gtf",
            "fa",
            "fasta",
            "fna",
            "faa",
            "fastq",
            "fq",
            "bw",
            "bigwig",
            "bedgraph",
            "fai",
            "nwk",
            "newick",
            "sdf",
            "mol2",
            "tif",
            "tiff",
            "zip",
            "tar",
            "bz2",
            "xz",
            "zst",
        ],
    ],
    ["doc", "markdown", ["md", "rmd", "qmd"]],
    ["doc", "html", ["html", "htm"]],
    ["doc", "latex", ["tex", "cls", "sty"]],
    ["doc", "bibtex", ["bib"]],
    ["doc", "rst", ["rst"]],
    ["doc", "text", ["txt", "docx", "pdf"]],
    ["structure", "text", ["pdb", "ent", "cif", "mmcif", "bcif"]],
];

// Two maps, thus a file named `R` or `json` does not match an extension key.
const TYPE_BY_EXTENSION: ReadonlyMap<string, FileType> = new Map(
    FILE_TYPES.flatMap(([kind, language, extensions]) => extensions.map((extension): [string, FileType] => [extension, { kind, language }])),
);
const TYPE_BY_NAME: ReadonlyMap<string, FileType> = new Map(
    FILE_TYPES.flatMap(([kind, language, , names = []]) => names.map((name): [string, FileType] => [name, { kind, language }])),
);

/**
 * The language ids that the highlighter of Flamme bundles: `[id, ...names]`, where a name is the display name in lower
 * case or an alias. The highlighter does not map a file name to a language, thus the server gives the id. The list is a
 * copy of the `bundledLanguagesInfo` of shiki 4.5.0, as text, thus the cli has no dependency on the highlighter. A
 * language that a later version adds shows as plain text in Flamme until this list changes.
 */
const HIGHLIGHT_LANGUAGES: readonly (readonly [id: string, ...names: string[]])[] = [
    ["abap"],
    ["actionscript-3", "actionscript", "as3"],
    ["ada"],
    ["ahk", "autohotkey", "ahk1"],
    ["ahk2", "autohotkey2"],
    ["angular-html", "angular html"],
    ["angular-ts", "angular typescript"],
    ["apache", "apache conf"],
    ["apex"],
    ["apl"],
    ["applescript"],
    ["ara"],
    ["asciidoc", "adoc"],
    ["asm", "assembly"],
    ["astro"],
    ["awk"],
    ["ballerina"],
    ["bat", "batch file", "batch", "cmd"],
    ["beancount"],
    ["berry", "be"],
    ["bibtex"],
    ["bicep"],
    ["bird2", "bird2 configuration", "bird"],
    ["blade"],
    ["bsl", "1c (enterprise)", "1c"],
    ["c"],
    ["c3"],
    ["cadence", "cdc"],
    ["cairo"],
    ["chapel", "chpl"],
    ["clarity"],
    ["clojure", "clj"],
    ["cmake"],
    ["cobol"],
    ["codeowners"],
    ["codeql", "ql"],
    ["coffee", "coffeescript"],
    ["common-lisp", "common lisp", "lisp"],
    ["coq", "rocq"],
    ["cpp", "c++"],
    ["crystal"],
    ["csharp", "c#", "cs"],
    ["css"],
    ["csv"],
    ["cue"],
    ["cypher", "cql"],
    ["d"],
    ["dart"],
    ["dax"],
    ["desktop"],
    ["diff"],
    ["docker", "dockerfile"],
    ["dotenv"],
    ["dream-maker", "dream maker"],
    ["edge"],
    ["elixir"],
    ["elm"],
    ["emacs-lisp", "emacs lisp", "elisp"],
    ["erb"],
    ["erlang", "erl"],
    ["fennel"],
    ["fish"],
    ["fluent", "ftl"],
    ["fortran-fixed-form", "fortran (fixed form)", "f", "for", "f77"],
    ["fortran-free-form", "fortran (free form)", "f90", "f95", "f03", "f08", "f18"],
    ["fsharp", "f#", "fs"],
    ["gdresource", "tscn", "tres"],
    ["gdscript", "gd"],
    ["gdshader"],
    ["genie"],
    ["gherkin"],
    ["git-commit", "git commit message"],
    ["git-rebase", "git rebase message"],
    ["gleam"],
    ["glimmer-js", "glimmer js", "gjs"],
    ["glimmer-ts", "glimmer ts", "gts"],
    ["glsl"],
    ["gn"],
    ["gnuplot"],
    ["go"],
    ["graphql", "gql"],
    ["groovy"],
    ["hack"],
    ["haml", "ruby haml"],
    ["handlebars", "hbs"],
    ["haskell", "hs"],
    ["haxe"],
    ["hcl", "hashicorp hcl"],
    ["hjson"],
    ["hlsl"],
    ["html"],
    ["html-derivative", "html (derivative)"],
    ["http"],
    ["hurl"],
    ["hxml"],
    ["hy"],
    ["imba"],
    ["ini", "properties"],
    ["java"],
    ["javascript", "js", "cjs", "mjs"],
    ["jinja"],
    ["jison"],
    ["json"],
    ["json5"],
    ["jsonc", "json with comments"],
    ["jsonl", "json lines"],
    ["jsonnet"],
    ["jssm", "fsl"],
    ["jsx"],
    ["julia", "jl"],
    ["just", "justfile"],
    ["kdl"],
    ["kotlin", "kt", "kts"],
    ["kusto", "kql"],
    ["latex"],
    ["lean", "lean 4", "lean4"],
    ["less"],
    ["liquid"],
    ["llvm", "llvm ir"],
    ["log", "log file"],
    ["logo"],
    ["lua"],
    ["luau"],
    ["make", "makefile"],
    ["markdown", "md"],
    ["marko"],
    ["matlab"],
    ["mdc"],
    ["mdx"],
    ["mermaid", "mmd"],
    ["mipsasm", "mips assembly", "mips"],
    ["mojo"],
    ["moonbit", "mbt", "mbti"],
    ["move"],
    ["narrat", "narrat language", "nar"],
    ["nextflow", "nf"],
    ["nextflow-groovy", "nextflow groovy"],
    ["nginx"],
    ["nim"],
    ["nix"],
    ["nsis"],
    ["nushell", "nu"],
    ["objective-c", "objc"],
    ["objective-cpp", "objective-c++"],
    ["ocaml"],
    ["odin"],
    ["openscad", "scad"],
    ["org", "org markup"],
    ["pascal"],
    ["perl"],
    ["php"],
    ["pkl"],
    ["plsql", "pl/sql"],
    ["po", "gettext po", "pot", "potx"],
    ["polar"],
    ["postcss"],
    ["powerquery"],
    ["powershell", "ps", "ps1", "pwsh"],
    ["prisma"],
    ["prolog"],
    ["proto", "protocol buffer 3", "protobuf"],
    ["pug", "jade"],
    ["puppet"],
    ["purescript"],
    ["python", "py"],
    ["qml"],
    ["qmldir", "qml directory"],
    ["qss", "qt style sheets"],
    ["r"],
    ["racket"],
    ["raku", "perl6"],
    ["razor", "asp.net razor"],
    ["rbs", "ruby-signature"],
    ["reg", "windows registry script"],
    ["regexp", "regex"],
    ["rel"],
    ["riscv", "risc-v"],
    ["ron"],
    ["rosmsg", "ros interface"],
    ["rst", "restructuredtext"],
    ["ruby", "rb"],
    ["rust", "rs"],
    ["sas"],
    ["sass"],
    ["scala"],
    ["scheme"],
    ["scss"],
    ["sdbl", "1c (query)", "1c-query"],
    ["shaderlab", "shader"],
    ["shellscript", "shell", "bash", "sh", "zsh"],
    ["shellsession", "shell session", "console"],
    ["smalltalk", "gnu smalltalk"],
    ["smithy"],
    ["solidity"],
    ["soy", "closure templates", "closure-templates"],
    ["sparql"],
    ["splunk", "splunk query language", "spl"],
    ["sql"],
    ["ssh-config", "ssh config"],
    ["stata"],
    ["stylus", "styl"],
    ["surrealql", "surql"],
    ["svelte"],
    ["swift"],
    ["system-verilog", "systemverilog"],
    ["systemd", "systemd units"],
    ["talonscript", "talon"],
    ["tasl"],
    ["tcl"],
    ["templ"],
    ["terraform", "tf", "tfvars"],
    ["tex"],
    ["toml"],
    ["ts-tags", "typescript with tags", "lit"],
    ["tsv"],
    ["tsx"],
    ["turtle"],
    ["twig"],
    ["typescript", "ts", "cts", "mts"],
    ["typespec", "tsp"],
    ["typst", "typ"],
    ["v"],
    ["vala"],
    ["vb", "visual basic"],
    ["verilog"],
    ["vhdl"],
    ["viml", "vim script", "vim", "vimscript"],
    ["vue"],
    ["vue-html", "vue html"],
    ["vue-vine", "vue vine"],
    ["vyper", "vy"],
    ["wasm", "webassembly"],
    ["wenyan", "文言"],
    ["wgsl"],
    ["wikitext", "mediawiki", "wiki"],
    ["wit", "webassembly interface types"],
    ["wolfram", "wl"],
    ["xml"],
    ["xsl"],
    ["yaml", "yml"],
    ["zenscript"],
    ["zig"],
];

// The alias `ftl` of FreeMarker is an alias of Fluent in the highlighter, and the alias `cql` of CQL is an alias of
// Cypher. Thus the join by alias gives each of them the grammar of a different language.
const LINGUIST_WITHOUT_GRAMMAR: ReadonlySet<string> = new Set(["CQL", "FreeMarker"]);

/** The kind of a Linguist type, or `null` for a type that Linguist adds later. */
function kindOfLinguistType(type: string): FileKind | null {
    switch (type) {
        case "programming":
        case "markup":
            return "code";
        case "prose":
            return "doc";
        case "data":
            return "data";
        default:
            return null;
    }
}

type LinguistMaps = { byName: ReadonlyMap<string, FileType>; byExtension: ReadonlyMap<string, FileType> };

let linguistMaps: LinguistMaps | null = null;

/** True when `candidate` takes an extension from `seen`: a grammar first, then the primary owner. Otherwise the first language keeps it. */
function winsTie(candidate: FileType & { primary: boolean }, seen: FileType & { primary: boolean }): boolean {
    const hasGrammar = candidate.language !== "text";
    if (hasGrammar !== (seen.language !== "text")) return hasGrammar;
    return candidate.primary && !seen.primary;
}

/**
 * The maps of the Linguist languages, by whole name and by extension, both in lower case. The kind comes from the
 * Linguist type, and the language is `text` when the highlighter has no grammar for the Linguist language. The maps build
 * on the first lookup that the table does not answer.
 *
 * A language with a grammar wins a tie, thus a language with no grammar adds a kind and never takes the highlight of a
 * file. The name map holds only a language with a grammar, because a whole name wins over an extension of the table: the
 * name `pom.xml` of Maven POM, which has no grammar, would take the `xml` of the table.
 */
function linguistMapsOf(): LinguistMaps {
    if (linguistMaps !== null) return linguistMaps;
    const highlightIdOf = new Map<string, string>();
    for (const [id, ...names] of HIGHLIGHT_LANGUAGES) for (const name of [id, ...names]) highlightIdOf.set(name, id);

    const byName = new Map<string, FileType>();
    const byExtension = new Map<string, FileType & { primary: boolean }>();
    // The keys of a module namespace are in code-unit order, thus the first language of a tie is the first Linguist name.
    const languages: readonly Language[] = Object.values(linguist);
    for (const language of languages) {
        const kind = kindOfLinguistType(language.type);
        if (kind === null) continue;
        const lower = language.name.toLowerCase();
        const candidates = LINGUIST_WITHOUT_GRAMMAR.has(language.name) ? [] : [lower, lower.replaceAll(" ", "-"), ...(language.aliases ?? [])];
        const id = candidates.map((candidate) => highlightIdOf.get(candidate)).find((found) => found !== undefined) ?? "text";

        if (id !== "text") {
            for (const filename of language.filenames ?? []) {
                const key = filename.toLowerCase();
                if (!byName.has(key)) byName.set(key, { kind, language: id });
            }
        }
        // Linguist lists the primary extension of a language first. After a grammar, the primary owner of an extension wins a tie.
        for (const [index, extension] of (language.extensions ?? []).entries()) {
            const key = extension.slice(1).toLowerCase();
            const candidate = { kind, language: id, primary: index === 0 };
            const seen = byExtension.get(key);
            if (seen === undefined || winsTie(candidate, seen)) byExtension.set(key, candidate);
        }
    }
    linguistMaps = { byName, byExtension };
    return linguistMaps;
}

/** The extension of a name in lower case, or `null` for a name with no extension. A leading dot alone is no extension. */
export function extensionOf(name: string): string | null {
    const dot = name.lastIndexOf(".");
    return dot <= 0 || dot === name.length - 1 ? null : name.slice(dot + 1).toLowerCase();
}

/**
 * The kind and the language of a file, or `null` for a name that the map does not know. The argument can be a name or a
 * path: only the part after the last separator counts. The order is a name entry, a Linguist file name, an extension of
 * the table, and a Linguist extension. Thus the table keeps the readings of an analyst, for example `m` is MATLAB, and a
 * whole name such as `CMakeLists.txt` wins over its extension. A `.gz` file takes the kind of the extension before `.gz`
 * when the table knows it, and `data` otherwise, and its language is `text`.
 */
function fileTypeOf(name: string): FileType | null {
    const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
    const lowerBase = base.toLowerCase();
    const byName = TYPE_BY_NAME.get(lowerBase) ?? linguistMapsOf().byName.get(lowerBase);
    if (byName !== undefined) return byName;
    const extension = extensionOf(base);
    if (extension === null) return null;
    if (extension === "gz") {
        const inner = extensionOf(base.slice(0, -".gz".length));
        return { kind: (inner === null ? undefined : TYPE_BY_EXTENSION.get(inner)?.kind) ?? "data", language: "text" };
    }
    return TYPE_BY_EXTENSION.get(extension) ?? linguistMapsOf().byExtension.get(extension) ?? null;
}

/**
 * The kind of a file from the map, or `null` for a name that the map does not know. Refer to {@link fileTypeOf}.
 *
 * The name is the only input. The artifact ledger of the harness classifies a file by its folder
 * (`harness/src/schemas/artifact-manifest.ts`), so the two can disagree for one file, and neither must change to match the other.
 */
export function fileKindOf(name: string): FileKind | null {
    return fileTypeOf(name)?.kind ?? null;
}

/** The highlighter language of a file from the map, or `text` for a name that the map does not know. Refer to {@link fileTypeOf}. */
export function languageOf(name: string): string {
    return fileTypeOf(name)?.language ?? "text";
}
