## Context

The spawn names a report thread with the placeholder `{parent title} — Report N`. The chat turn seeds the title of a conversation from its first prompt. A person renames a thread through a host, and each host calls `ThreadStore.updateTitle`. The row does not record which author wrote the title.

## Goals / Non-Goals

**Goals:**

- Name a report thread after its report, and keep the name current while the report changes.
- Never replace a title that a person set.
- Give one guarded write for each automatic title, for each thread type.

**Non-Goals:**

- The flag in the `Thread` value or in the thread API of a host.

## Decisions

### A flag records the rename of a person

`updateTitle` sets `title_set_by_user` in the same statement as the title. Its callers are the rename routes of the hosts, thus no host changes its code.

### One guarded write for each automatic title

`setAutoTitle` writes only while the flag is false, and it does not set the flag. Thus a later automatic title replaces an earlier one, and a rename by a person stops each later automatic title.

### The report title

After the stamp, the preview gives the trimmed document title to `setAutoTitle`. It writes before the part, thus a client that reads the thread list on the part gets the new title. A failed write logs a warning, and the render keeps its result.

## Risks / Trade-offs

- A report thread that a person renamed before the migration has the flag false, thus its next render replaces the name. → A new rename sets the flag. A conversation is not affected, because its seed writes only an empty title.
