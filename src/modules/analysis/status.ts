import { resolveContext, describeContext, type ContextFlags } from "./context.ts";
import { dieOn } from "../../lib/cli.ts";

/** `inf status` — print what `inf` resolves to right now (loud context). Read-only; launches nothing. */
export function runStatus(flags: ContextFlags): void {
    const ctx = resolveContext(process.cwd(), flags).match((c) => c, dieOn("Failed to resolve context"));

    console.log(describeContext(ctx));

    switch (ctx.kind) {
        case "analysis":
            console.log(`  anchor:      ${ctx.anchorPath}`);
            console.log(`  anchor id:   ${ctx.analysis.anchorId}`);
            console.log(`  analysis:    ${ctx.analysis.id}  ${ctx.analysis.name}`);
            return;
        case "anchor": {
            console.log(`  anchor:      ${ctx.anchorPath}`);
            const [first] = ctx.analyses;
            if (first) console.log(`  anchor id:   ${first.anchorId}`);
            console.log(`  analyses:    ${ctx.analyses.length}`);
            for (const a of ctx.analyses) console.log(`    - ${a.id}  ${a.name}`);
            return;
        }
        case "pick":
            console.log(`  candidates:  ${ctx.analyses.length}`);
            for (const a of ctx.analyses) console.log(`    - ${a.id}  ${a.name}`);
            return;
        case "empty":
            console.log(`  no anchor here; \`inf\` would start a new analysis in ${ctx.cwd}`);
            return;
        case "copy":
            console.log(`  copied folder — re-mint or relocate before use (\`inf repair\`/\`inf relocate\`)`);
            return;
    }
}
