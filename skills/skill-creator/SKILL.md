---
name: skill-creator
description: Read before you write a new skill, change a skill, or help the user turn a method, a lab protocol, or a lesson from an analysis into a skill that an agent can use again.
metadata:
  version: 1.0.0
  tags: [skills, customization, authoring]
  category: customization
---

# Skill creator

A skill is a folder with a `SKILL.md` file. The file gives an agent the knowledge for one kind of task. Each agent sees only the name and the description of each skill that it attaches. The agent reads the body when the task needs it. Thus a skill costs nothing until an agent uses it.

The points below are suggestions from the built-in skills. The user knows their field and their lab. If the user wants a different approach, try it and let the result decide.

## Start from the need

Ask what the agent got wrong, or what the user explains again in each session. A skill that answers one real need works better than a general summary of a field. Ask for an example: a past analysis, a protocol, a paper, or a correction that the user gave.

If the user already has a skill in a different app, an import is often faster than a new skill.

## The file

```markdown
---
name: lipid-identification
description: Read before you identify or quantify lipids from LC-MS data. It gives the adduct rules, the class-specific fragments, and the normalization that the lab uses.
metadata:
  version: 1.0.0
  tags: [lipidomics, lc-ms]
  category: lipidomics
---

# Lipid identification

The body.
```

- `name` is the name of the folder: lowercase letters, digits, and hyphens.
- The `description` decides when an agent reads the skill. Start it with "Read before you", and name the inputs and the questions that the skill covers. Write it on one line.
- `metadata.category` groups the skill in the list of skills. `tags` help a search.
- The first heading of the body is the title that a person sees.

## The body

These patterns help in the built-in skills:

- Give the goal and the constraints of the task. A decision tree helps when the method depends on the data. A fixed sequence of steps can stop an agent from an adaptation to the data.
- Keep the facts that a model does not know: a threshold of the lab, a trap of an instrument, a published list, a lesson from an earlier analysis.
- Name a dataset or a resource by its domain name, for example "MSigDB hallmark". The agent finds the location with its tools, and the location can change.
- Say what to do when a resource is not there.
- Keep the body short. Put long detail in a `references/` folder next to `SKILL.md`, and list each file in the body. The agent reads a reference file only when it needs it.

## Save and try the skill

Write the folder in the workspace, then import it into the custom skills of the user. To change a skill that exists, copy it into the workspace, change the copy, and import it again with the replace option. Then attach the skill to the agents that need it. Tell the user where the skill is and which agents use it.

A chat agent gets a new skill from the next message of the user. To try the skill, ask the user for a real request from the lab, and look at how the agent uses the skill. If the agent does not read the skill, the description does not match the request. If the agent reads it but the result does not improve, the body does not give what the task needs. Change the skill and import it again.
