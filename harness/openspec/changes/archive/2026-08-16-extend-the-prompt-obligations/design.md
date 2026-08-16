# Design: extend-the-prompt-obligations

## Context

The prompt module composes the conversational part of the Report Builder (`src/prompts/report-session.ts`). It carries the loop order, the fault checklist, the narrative spine, the chart-first rule, the headline obligations, and the "Do NOT" list. The prompt names tools and mechanisms, and it never names a dataset, a path, or a format.

## Decisions

### D1: Each obligation rides the section that owns its moment

The zero-p rule and the notation agreement join the grounding prose, beside the transcribe-from-memory ban. The reader-words rule joins the narrative section. The derive-and-chart rule extends the chart-first paragraph, because it is the same preference one step deeper. The headline derivation joins the headline obligations. The declaration and the row bound join the tool paragraphs of the binding. A new section would fragment the prompt, and the existing sections carry the voice.

### D2: The named cases stay mechanism-level

The KM and the GSEA cases name the preset and the orientation, and never a dataset or a column. "A survival figure derives its step table and binds the `km` preset" teaches the mechanism, and the environment supplies the specifics.

### D3: The "Do NOT" list grows by two

The zero-p transcription and the raw-token prose join the list, in the existing entry style: the fault, and the honest alternative in one breath.

### D4: The probes end through two sentences, not a checklist

"A metric binds a numeric cell" and "check the add arguments before the call" cover the observed probe waste. A longer procedure would pad the prompt for a marginal return.

## Risks / Trade-offs

- The prompt grows by roughly a paragraph across sections. The cache pays one write, and every session reads the same constant after it.
