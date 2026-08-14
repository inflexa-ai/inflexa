# Tasks — Agent-Requested Packages

## 1. The version ordering in the graph

- [ ] 1.1 Add the per-name ordering to the emitter: for each canonical name, the store directories newest-first
- [ ] 1.2 Order the Python side with `packaging.version`, thus an epoch, a post-release, and a local version each order correctly
- [ ] 1.3 Order the R side with the dotted-decimal rule, which accepts a `-` as a separator
- [ ] 1.4 Put a release before a pre-release of a later version, and keep the pre-release reachable by an explicit version
- [ ] 1.5 Raise the schema version of the graph, and refuse a graph whose version this reader does not know
- [ ] 1.6 Do a test: three versions of one name order newest-first, and 1.10.3 comes before 1.9.0

## 2. The warm of an acquisition

- [ ] 2.1 Point the cache of a preparation run at the shared home, and not at the farm that the run bound
- [ ] 2.2 Make an acquisition run warm what it acquired, with a farm that holds the new package bound at the container path
- [ ] 2.3 Keep the refusal of a run that builds a farm and warms it together, because a publish supersedes the bound directory
- [ ] 2.4 Do a test: the warm of an acquisition writes into the shared home, and not into the farm that it bound
- [ ] 2.5 Do a test: a package acquired after the catalog build loads its prepared entries in a second farm

## 3. The farm-extension seam

- [ ] 3.1 Declare the seam in `sandbox/types.ts`: an analysis id and a set of requests in, one outcome for each request out
- [ ] 3.2 Accept a distribution requirement or an import name in a request, and resolve an import name through the graph
- [ ] 3.3 Take the head of the version ordering when a request names no version
- [ ] 3.4 Give the four outcome states, and say for an absent package whether an acquisition of that ecosystem is possible
- [ ] 3.5 Make a version collision tell the caller to report it and to stop, because a farm holds one version of a name
- [ ] 3.6 Add the seam to `SandboxAgentDeps` as an optional member
- [ ] 3.7 Do a test: an import name resolves to its distribution, and an unknown name refuses with its reason

## 4. The `link_packages` tool

- [ ] 4.1 Add `link_packages` to the closed allowlist in `agents/sandbox/types.ts`
- [ ] 4.2 Build the tool over the seam, and state in its own description that it links and never installs
- [ ] 4.3 Resolve it into the tool surface only when the seam is bound, in the shape that `report_blocker` uses
- [ ] 4.4 Correct the sandbox-agent standards text: the agent installs nothing, and it can link a package that the store holds
- [ ] 4.5 Do a test: an agent under a bound seam holds `link_packages`, and an agent under no seam does not
- [ ] 4.6 Do a test: no `meta.tools` declares it, exactly as none declares `report_blocker`

## 5. The planner names the packages of its plan

- [ ] 5.1 Add the package set to the planner outcome, named per step
- [ ] 5.2 State in the planner prompt that it names the packages of each step, and that it names no location
- [ ] 5.3 Make `validate_plan` refuse a package name that is not a requirement
- [ ] 5.4 Do a test: a plan carries the packages of each step, and a malformed name is refused

## 6. The effectiveness check through the entrypoint

- [ ] 6.1 Start the runtime image through its own entrypoint in the check, and remove the copy commands of the invoker
- [ ] 6.2 Point the check at a composed farm, whose cache directories are links into the shared home
- [ ] 6.3 Do a test: an entrypoint that seeds nothing fails the check
- [ ] 6.4 Make sure that the check still reads the record of the preparation run, and that it fails on a write to a recorded entry

## 7. The spec sync

- [ ] 7.1 Correct the `lib-store` claim that a store change reaches only a later sandbox, and keep the refusal of an in-sandbox install
- [ ] 7.2 Make sure that the `per-analysis-farm-mount` deltas still hold beside these deltas, and adjust where they disagree
- [ ] 7.3 Run `openspec validate agent-requested-packages --strict` and resolve each finding
