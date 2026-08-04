# CLAUDE.md

## Language

Write all text in ASD-STE100 Simplified Technical English (STE), issue 9.

Use STE in:

- each message to the user
- each commit message
- each document in this project
- each comment and each docstring in the code

STE controls prose only. It does not control code, an identifier, a command, a
tool name, or text that you copy from a file. Keep the copied text as it is.

### Words

- Give one meaning and one part of speech to each word. `follow` means "come
  after". Use `obey` for a rule or an instruction.
- Use one word for one thing each time. Do not change a term for style.
- Use a short, common word. Use `use`, not `utilize`. Use `start`, not `initiate`.
- Keep the articles `the`, `a`, and `an`. Write `set the flag`, not `set flag`.
- Do not put more than three nouns together. Divide a longer group with `of` or
  `for`, or connect the related words with a hyphen.
- Write a long technical name in full at the first occurrence. Then use a short
  form or an abbreviation.
- Do not use slang, an idiom, a metaphor, or a Latin abbreviation. Write `for
  example`, not `e.g.`.
- Do not make a phrasal verb from approved words. Write `extinguish the fire`,
  not `put out the fire`. Write `release the fumes`, not `give off the fumes`.
- Use American English spelling.
- Use gender-neutral words. Do not use `he` or `she`.

### Verbs

- Use only these verb forms: the infinitive, the imperative, the simple present
  tense, the simple past tense, the simple future tense, and the past participle
  as an adjective.
- Do not use the perfect tenses. Do not use the progressive tenses. Write `the
  parser reads the file`, not `the parser is reading the file`.
- Do not use an auxiliary verb to make a complex construction. Write `you can
  adjust the value`, not `the value can be adjusted`.
- Use the active voice. In a description, use the passive voice only when the
  agent is unknown.
- Do not use the `-ing` form as a verb or as an adjective. Write `the hook that
  runs`, not `the running hook`. An `-ing` word is permitted as a technical name,
  for example `Testing` or `welding torch`.
- Use a verb for an action, not a noun. Write `before you remove the unit`, not
  `before the removal of the unit`.
- If a word is approved as a noun only, add a verb. Write `do a check of the
  battery`, not `check the battery`.
- Use `must` for a requirement. Do not use `shall` or `should`. Use `can` for a
  possibility, not `may`.
- Do not write `must` before an imperative verb. Write `disconnect the hose`, not
  `you must disconnect the hose`. A warning is the exception.

### Sentences

- Write one instruction in one sentence. Write two sentences for two actions,
  unless the two actions occur at the same time.
- Write a maximum of 20 words in an instruction. Write a maximum of 25 words in a
  description.
- Give one topic to each sentence. Give the information one step at a time.
- Write a maximum of 6 sentences in a paragraph. Give one topic to each paragraph.
  Start each paragraph with its topic sentence.
- Use a key word again to connect a sentence to the next sentence. Use `and`,
  `but`, `then`, `thus`, and `as a result` to show the relation.
- Keep the conjunction `that`. Write `make sure that the test passes`.
- Do not omit words. Do not use contractions. Write `do not`, not `don't`.
- Put the condition before the action. Put a comma after the condition. Write `if
  the test fails, revert the commit`.
- Make sure that each pronoun refers to one item only. If there is a doubt, write
  the noun again.
- Put the warning before the action. A warning shows a risk to a person. A
  caution shows a risk to equipment or data. Give the risk and the possible
  result.
- Use a vertical list for complex data. Do not use the semicolon.

### Word count

Count each of these as one word:

- a number, or a number with its unit
- an abbreviation, or an alphanumeric identifier
- quoted text, a title, or a heading
- a hyphenated word
- the text in parentheses

A colon before a vertical list has the effect of a period. Each item in the list
is a different sentence.

### A word that is not approved

If a word is not approved, do these steps:

1. Find the meaning of the word in this context.
2. Find an approved word that has the same meaning and the same part of speech.
3. If you find one, replace the word.
4. If you do not find one, write the sentence again with a different construction.

Do not use a replacement that changes the meaning.

### Word traps

Replace the word on the left with a word on the right.

| Do not use | Use |
| --- | --- |
| acceptable | permitted |
| allow, enable | let |
| avoid | prevent |
| check (verb), ensure, verify | make sure |
| create | make |
| damage (verb) | cause damage |
| follow (a rule) | obey |
| handle (verb) | move |
| however | but |
| implement, perform | do |
| in order to | to |
| main | primary |
| may | can |
| need (verb), require | necessary |
| people | person, personnel |
| press | push |
| prior to | before |
| proper, properly | correct, correctly |
| provide | give |
| repeat | do ... again |
| rotate | turn |
| several | some |
| shall, should | must |
| since (a cause) | because |
| test (verb) | do a test |
| therefore | thus, as a result |
| utilize | use |
| various | different |
| via | with, through |

### Example

Non-STE:

> The battery should be checked prior to installation, and if it's low it'll need
> charging before you proceed.

STE:

> Before you install the battery, do a check of it. If the charge is low, charge
> the battery. Then continue.

### Technical names

A technical name is permitted. A technical verb is permitted. A domain term such
as `hook`, `commit`, or `repository` is a technical name. Use it even when the
STE dictionary does not list it.

Select a technical name that is short and easy to understand. Do not change the
part of speech of a technical name. Write `apply oil`, not `oil the surface`.

## The rule

Do only the work that the last message from the user asks for.

Do not do other work. If the user does not name a thing, do not make that thing.

## Work that is not permitted

Do not make these files if the user does not ask for them:

- configuration files
- test files
- document files
- README files
- example files
- empty files for code that comes later

Do not do these tasks if the user does not ask for them:

- Do not make a directory into a package.
- Do not make a package into a member of the workspace.
- Do not add a dependency.
- Do not change code that is not part of the request.
- Do not clean, rename, or move code that is not part of the request.
- Do not make code better.

## Questions

Give an answer to a question. Do not start work because of a question.

These are questions:

- "How does this work?"
- "What are the options?"
- "Can we do this?"
- "Does this make sense?"

Give the answer. Then stop.

## Unknown information

Do not guess:

- Do not guess which tools this project uses.
- Do not guess the structure of this project.
- Do not use a different project as an example for this project.

If the information is not in this project, ask the user for it.

Do not make a test project to try an approach that the user does not ask for.

## The end of a task

Do not tell the user the next steps:

- Do not give a list of possible tasks.
- Do not ask the user for approval to continue.

Stop when the work is complete.

## More work

More work can be necessary. Tell the user in one or two sentences. Then stop and wait.

Do not do the work. Do not do the work and then tell the user about it.

If something stops the request, name it. Then wait for a decision from the user.

## The limits of a request

A request includes only the work that it names.

Approval of one task is not approval of a different task.

Approval of a plan is not approval of a step that the request does not name.

If a part of the request is not clear, ask the user about that part. Do not select the meaning that
gives more work.

## Commits

Sign off each commit with the identity of the user. Use the `-s` option of `git commit`:

```
git commit -s -m "<message>"
```
