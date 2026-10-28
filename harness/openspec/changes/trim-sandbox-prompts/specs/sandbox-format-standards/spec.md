# Spec Delta

## REMOVED Requirements

### Requirement: The orient prompt teaches the path model without naming a path

**Reason**: The requirement pinned the wording of the orient core: the `out_of_prefix` result, the `cd` rule, and "do not invent or guess" a path. The descriptions of `write_file` and `execute_command` now carry those rules, and the orient core keeps only the path model that no tool carries.

**Migration**: None. "Sandbox agent system prompt is a pure function of the agent type" (harness-sandbox-agents) and "The step seed carries the concrete paths, not the system prompt" keep the code contract: no path, id, or placeholder in the system prompt.

### Requirement: Command-execution discipline keeps execute_command primary

**Reason**: The Command Execution section of the orient core is deleted, because the tool descriptions now carry its rules. The requirement also made two claims that the code does not make true. `list_files` does not replace a `find -name` search, because it does not recurse. `grep` is not ripgrep: it tests a JavaScript regular expression on each line.

**Migration**: None. The descriptions of `read_file`, `list_files`, `grep`, and `file_stat` state that each one reads the workspace directly and runs no sandbox command. The description of `execute_command` states the shell form, the `cd` rule, and the quote rule for a path that holds a space.

### Requirement: Data-profiler orients via workspace tools, not cd and ls

**Reason**: The requirement pinned the wording of the data-profiler prompt, which no longer repeats how `list_files` resolves a path or that it does not recurse. The `list_files` description carries both facts.

**Migration**: None. The profiler still orients from the menu in its first message, and `src/prompts/sandbox/test/data-profiler.test.ts` pins the menu rule and the re-scan rule.
