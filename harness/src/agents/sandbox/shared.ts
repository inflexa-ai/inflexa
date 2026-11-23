/**
 * Sandbox-agent composition root.
 *
 * `createSandboxAgent(deps, spec, opts?)` produces a fully dep-bound
 * `AgentDefinition` for one sandbox agent (see the harness-durable-runtime spec): SOUL kernel + the
 * agent's own prompt body + sandbox standards composed into a single
 * static `systemPrompt` string (no processors at request time, see the harness-providers spec),
 * the role tools — the workspace mutate trio (`execute_command` bound to the lease of the step, and
 * `write_file` / `edit_file` confined to the step's `allowedWritePrefix` through the host-side
 * `WorkspaceMutator`), the workspace read tools over the shared `WorkspaceFilesystem`,
 * `inspect_data_profile` over the shared `Pool`, and the skill tools — and the tools of the connectors
 * and the MCP servers that the agent attaches (its equipment, built from the catalog).
 */

import type { Querier } from "../../state/db.js";
import { createEditIntentStore } from "../../state/edit-intents.js";

import type { ToolOutputStore } from "../../loop/tool-output.js";
import type { AgentDefinition } from "../../loop/types.js";
import type { ChatProvider, EmbeddingProvider } from "../../providers/types.js";
import type { BoundLease } from "../../sandbox/leases.js";
import type { ExtendAnalysisFarm, ToolchainSource } from "../../sandbox/types.js";
import type { Tool } from "../../tools/define-tool.js";
import type { WorkspaceFilesystem } from "../../workspace/filesystem.js";
import type { ProvenanceCollector as LineageCollector } from "../../provenance/collector.js";
import { createWorkspaceReadLineage, type WorkspaceReadLineage } from "../../provenance/workspace-reads.js";

import { sandboxOrientCorePromptFor, sandboxAnalysisStepStandardsPrompt } from "../../prompts/sandbox-standards.js";
import { composeSystemPrompt } from "../system-prompt.js";

// Sandbox-environment introspection, plus the farm-extension seam face.
import { createDownloadRefTool, createLinkPackagesTool, createListAvailablePackagesTool, createListAvailableRefsTool } from "../../tools/sandbox/index.js";

// Data-profile retrieval (dependency-bearing) — always-on, see `createSandboxAgent`.
import { createInspectDataProfileTool } from "../../tools/research/inspect-data-profile.js";

// Workspace read surface.
import { createFileStatTool, createGrepTool, createListFilesTool, createReadFileTool, createWorkspaceSearchTool } from "../../tools/workspace/index.js";
import { createScanInputsTool } from "../../tools/workspace/scan-inputs.js";

// Workspace mutate surface.
import { createEditFileTool, createExecuteCommandTool, createWorkspaceMutator, createWriteFileTool } from "../../tools/workspace/index.js";

import { createReadToolOutputTool } from "../../tools/read-tool-output.js";
import { createAcquireSandboxTool, createReleaseSandboxTool } from "../../tools/sandbox/lease-tools.js";
import { createReportBlockerTool } from "../../tools/sandbox/report-blocker.js";
import { createSubmitFileMetadataTool, type FileMetadataCell } from "../../tools/sandbox/submit-file-metadata.js";

import { toSandboxPath } from "../../workspace/paths.js";

import type { EnvironmentStorePaths } from "../../config/environment-stores.js";
import type { Logger } from "../../lib/logger.js";
import { createRunTemplateTool, type StepTemplate, type TemplateSource } from "../../tools/knowledge/index.js";
import { templateStepPrompt } from "../../prompts/sandbox/template-step.js";
import type { AgentEquipment } from "../../catalog/equip.js";
import { createSkillTools } from "../../tools/sandbox/skills.js";
import { SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS } from "./types.js";
import { createReadScriptTools } from "../../tools/script/file-tools.js";
import type { ScriptRuntime } from "../../tools/script/run-script.js";

/** Per-step coordinates the composition root threads through every mutate tool. */
export type SandboxStepCoords = {
    /** The lease of the step. `acquire_sandbox` and `release_sandbox` drive it, and each command runs on it. */
    readonly lease: BoundLease;
    /** Absolute host root of this analysis's workspace tree (resolved at the workflow body). */
    readonly workspaceRoot: string;
    readonly analysisId: string;
    /** Absolute writable artifact directory for this step (e.g. stepWritePrefix(...)). */
    readonly allowedWritePrefix: string;
    /** The template of a template step, from the durable step input. Absent for an open step. */
    readonly template?: StepTemplate;
};

/** The shared dependency graph every sandbox agent draws from. */
export type SandboxAgentDeps = EnvironmentStorePaths & {
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
    readonly provider: ChatProvider;
    readonly pool: Querier;
    /** The toolchain of the sandboxes, as the sandbox client declares it. The orient-core prompt keys on it. */
    readonly toolchainSource: ToolchainSource;
    readonly workspaceFs: WorkspaceFilesystem;
    /** Embedding provider for in-sandbox semantic `workspace_search`. Omit to skip that tool. */
    readonly embedding?: EmbeddingProvider;
    /**
     * Step-scoped lineage collector fed by each `execute_command`'s
     * `ExecResult.provenance` frame, and by the reads of `read_file`, `grep`, and
     * `read_pdf`. Records the input/script edges post-step registration
     * translates into provenance parents.
     */
    readonly lineageCollector?: LineageCollector;
    /** Model id provenance label — the provider owns the wire model. */
    readonly model: string;
    /** Per-step coordinates resolved at the workflow body. */
    readonly step: SandboxStepCoords;
    /**
     * The agent gets a `report_blocker` tool (see the harness-sandbox-agents spec), and the
     * sandbox-step body selects the blocker from the recorded calls of the run. Omit for agents that
     * have no terminal status to declare (such as the data profiler).
     */
    readonly reportsBlocker?: boolean;
    /**
     * When present, the agent declares `submit_file_metadata` from its first request so the
     * tool list stays stable across continuations; the task masks it, the continuation unmasks it.
     */
    readonly fileMetadata?: FileMetadataCell;
    /** Adds `read_tool_output`. The loop of the agent must keep its texts in the same store. */
    readonly toolOutputStore?: ToolOutputStore;
    /**
     * The farm-extension seam of the embedder. When it is bound, every
     * sandbox agent gets the `link_packages` tool in its always-on substrate.
     * The system prompt is the same with and without it: the descriptions of
     * `link_packages` and `list_available_packages` carry the link rules.
     */
    readonly extendAnalysisFarm?: ExtendAnalysisFarm;
    /**
     * Where the templates come from. The agent of a template step gets `run_template` over it, and the agent of an
     * open step never does. Absent, a template step has no way to run its template.
     */
    readonly templateSource?: TemplateSource;
    /** Where the VM of `run_script` comes from, for the lookups of the agent. */
    readonly scriptRuntime?: ScriptRuntime;
};

/** Per-agent override for the prompt composition and tool surface. */
export type SandboxAgentPromptOptions = {
    /** Append `sandboxAnalysisStepStandardsPrompt`. Defaults to true. */
    readonly appendAnalysisStepStandards?: boolean;
    /**
     * Enforced read-only: omit `write_file` + `edit_file` from the workspace
     * surface. `execute_command` and all read tools stay. Pair with a sandbox
     * provisioned with no read-write mount so no writable location
     * exists outside container-local `/tmp`. Defaults to false.
     */
    readonly readOnly?: boolean;
};

/** Build the workspace mutate + read tools every sandbox agent receives. In
 *  `readOnly` mode the write_file/edit_file pair is omitted; execute_command
 *  and the read tools stay. */
function buildWorkspaceTools(deps: SandboxAgentDeps, readOnly: boolean, readLineage: WorkspaceReadLineage | undefined): Tool[] {
    const { step, workspaceFs, pool, embedding, lineageCollector } = deps;

    // The agent's writable working directory: relative paths resolve here, and
    // writes are confined here. `allowedWritePrefix` is its host path; the
    // in-sandbox path (the `execute_command` default cwd, see the harness-workspace-tools spec) is the same
    // location under the `/{analysisId}` mount — derived from the host path so
    // it is correct for non-step agents such as the data profiler too.
    const hostWorkingDir = step.allowedWritePrefix;
    const sandboxWorkingDir = toSandboxPath(step.workspaceRoot, step.analysisId, hostWorkingDir);

    const mutator = readOnly
        ? undefined
        : createWorkspaceMutator({
              workspaceRoot: step.workspaceRoot,
              analysisId: step.analysisId,
              workingDir: hostWorkingDir,
              lineageCollector,
          });
    const mutateTools = mutator
        ? [
              createWriteFileTool({ mutator }),
              createEditFileTool({ mutator, workspaceFilesystem: workspaceFs, workingDir: hostWorkingDir, intents: createEditIntentStore(pool) }),
          ]
        : [];
    // Only the agent of a template step runs a template, over the same mutator and lease as its other tools.
    const runTemplate =
        mutator && step.template && deps.templateSource
            ? [
                  createRunTemplateTool({
                      source: deps.templateSource,
                      template: step.template.ref,
                      binding: step.template.binding,
                      mutator,
                      lease: step.lease,
                      workingDir: sandboxWorkingDir,
                      lineageCollector,
                      mountRoot: `/${step.analysisId}`,
                      farmLockFile: deps.farmLockFile,
                      imagePackagesFile: deps.imagePackagesFile,
                      logger: deps.logger,
                  }),
              ]
            : [];

    return [
        createAcquireSandboxTool(step.lease),
        createReleaseSandboxTool(step.lease),
        createExecuteCommandTool({
            logger: deps.logger,
            lease: step.lease,
            defaultCwd: sandboxWorkingDir,
            lineageCollector,
            mountRoot: `/${step.analysisId}`,
        }),
        ...mutateTools,
        ...runTemplate,
        createReadFileTool(workspaceFs, hostWorkingDir, readLineage),
        createListFilesTool(workspaceFs, hostWorkingDir),
        createFileStatTool(workspaceFs, hostWorkingDir),
        createGrepTool(workspaceFs, hostWorkingDir, readLineage),
        ...(embedding ? [createWorkspaceSearchTool(pool, embedding)] : []),
    ];
}

/** What one sandbox agent is: its prompt, the role that gives its role tools, and its equipment from the catalog. */
export type SandboxAgentSpec = {
    readonly id: string;
    readonly role: "executor" | "profiler";
    readonly prompt: string;
    readonly equipment: AgentEquipment;
    /** Per-agent override for `maxIterations`; defaults to {@link SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS}. */
    readonly defaultMaxSteps?: number;
};

/**
 * Build one sandbox `AgentDefinition`. The system prompt is composed once
 * (SOUL execution core + agent body + skill index + sandbox standards) — no processors, and
 * neither human-facing SOUL layer: a sandbox agent is headless, so the identity
 * and conversational layers are dead weight in its context while every hard
 * guardrail it does need rides in the execution core.
 *
 * The composed `systemPrompt` is a **pure function of the agent and the kind of the step** — its prompt, its
 * attached skills, and the presence of `deps.step.template`. Nothing else from `deps.step` reaches it, so two steps
 * of one kind, and two runs of one
 * analysis, send a byte-identical prefix that the provider's prompt
 * cache can actually reuse. Keep it that way: a single interpolated id or path
 * makes every step's prefix unique again, and each step pays a full cache write
 * and reads nothing back. Per-step values belong in the step's briefing (its
 * first user message — see `prompts/briefing.ts`), which names the working
 * directory, the analysis root, the dataset, and what each dependency produced.
 */
export function createSandboxAgent(deps: SandboxAgentDeps, spec: SandboxAgentSpec, opts: SandboxAgentPromptOptions = {}): AgentDefinition {
    const appendStandards = opts.appendAnalysisStepStandards ?? true;
    // The layer order is fixed by the harness-sandbox-agents spec: the agent
    // body, the skill index, the orient core keyed on the toolchain of the sandbox client, then
    // the step standards.
    // The client is the one declaration: the environment it provisions and the
    // text that describes it come from the same value, thus a bag cannot
    // describe a toolchain the sandbox does not have.
    const sandboxLayer = [
        sandboxOrientCorePromptFor(deps.toolchainSource),
        ...(appendStandards ? [sandboxAnalysisStepStandardsPrompt] : []),
        ...(deps.step.template ? [templateStepPrompt] : []),
    ];
    const { equipment } = spec;
    const agentBody = [spec.prompt, ...(equipment.skillIndex === undefined ? [] : [equipment.skillIndex]), ...sandboxLayer].map((s) => s.trim()).join("\n\n");

    const systemPrompt = composeSystemPrompt(agentBody);

    const skillTools = Object.values(createSkillTools({ store: equipment.skillStore, skills: equipment.skills }));
    // The working directory is the one of the read tools, thus a relative path resolves to the same file.
    const readLineage = deps.lineageCollector
        ? createWorkspaceReadLineage({
              collector: deps.lineageCollector,
              workspaceRoot: deps.step.workspaceRoot,
              analysisId: deps.step.analysisId,
              workingDir: deps.step.allowedWritePrefix,
              logger: deps.logger,
          })
        : undefined;
    const workspaceTools = buildWorkspaceTools(deps, opts.readOnly ?? false, readLineage);
    // The profiler describes the input data, and it never needs a reference, thus only a step agent downloads.
    const downloads = deps.referenceDownloads !== undefined && spec.role === "executor";
    const tools: Tool[] = [
        ...workspaceTools,
        ...(deps.toolOutputStore ? [createReadToolOutputTool(deps.toolOutputStore)] : []),
        // Always-on: the data profile is the only
        // record of what the analysis's input dataset IS, and no file carries it (the
        // profiler's scratch tree is deleted on completion). An agent that cannot pull
        // it has no fallback but to re-derive organism, dimensions, and format from the
        // raw bytes — so every sandbox agent gets it.
        createInspectDataProfileTool(deps.pool),
        // Always-on when the seam is bound — an attachment would break an embedder
        // that binds no seam (the harness-sandbox-agents spec).
        ...(deps.extendAnalysisFarm ? [createLinkPackagesTool({ extendAnalysisFarm: deps.extendAnalysisFarm, analysisId: deps.step.analysisId })] : []),
        ...skillTools,
        // The environment of the step: role tools, and direct.
        createListAvailablePackagesTool({
            farmLockFile: deps.farmLockFile,
            imagePackagesFile: deps.imagePackagesFile,
            // The bound seam adds `link_packages` above, and the description of
            // the listing must then stop at "absent", not at "missing".
            linkToolPresent: deps.extendAnalysisFarm !== undefined,
        }),
        createListAvailableRefsTool({ refStorePath: deps.refStorePath, canDownload: downloads }),
        ...(deps.referenceDownloads && downloads ? [createDownloadRefTool(deps.referenceDownloads)] : []),
        ...(spec.role === "profiler"
            ? [createScanInputsTool({ workspaceFs: deps.workspaceFs, analysisId: deps.step.analysisId, lease: deps.step.lease })]
            : []),
        ...equipment.mcp.direct,
        ...(deps.reportsBlocker === true ? [createReportBlockerTool()] : []),
        ...(deps.fileMetadata ? [createSubmitFileMetadataTool(deps.fileMetadata)] : []),
    ];

    return {
        id: spec.id,
        systemPrompt,
        model: deps.model,
        tools,
        // Each lookup of an outside source runs in `run_script`. A table, a paper, or a compressed file of the
        // analysis is a first look that needs no sandbox, thus each agent reads them in a script on the host.
        scriptTools: [
            ...equipment.connectorTools,
            ...equipment.mcp.script,
            ...createReadScriptTools({
                workspaceFs: deps.workspaceFs,
                resolveWorkspaceRoot: () => Promise.resolve(deps.step.workspaceRoot),
                lineage: readLineage,
            }),
        ],
        scriptRuntime: deps.scriptRuntime,
        maxIterations: spec.defaultMaxSteps ?? SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS,
    };
}
