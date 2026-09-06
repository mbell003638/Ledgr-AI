# On-device agent: giving Needle real tools, reads, and a loop

**Written to be picked up cold.** If you have never seen this repository,
everything you need is here. Do not assume prior context.

- **Status:** Phase 0 done and verified. Phases 1–4 not started.
- **Applies to:** all four branches (`main`, `Manus-on-device-ai`,
  `codex-sol-on-device-ai`, `Ledger-Ai`). The on-device AI files are shared.
- **Last updated:** 2026-09-07.

**Goal.** Make the on-device assistant able to look things up, act on the app,
and explain what the app does — without ever writing to the ledger unattended.

---

## 1. What already exists

This is not a from-scratch agent. Most of the machinery is in place:

| Piece | Where | State |
|---|---|---|
| Grammar-constrained tool engine | Needle 2, `NeedleJni` / `needle_jni.cpp` | works, cannot hallucinate a tool name |
| Tool registry (16 writes) | `src/accountingV2/onDeviceTools.ts` | works |
| Parameter schemas | `scripts/on-device-ai/ledgr-tools.json` | **exists — it is the training set** |
| Argument validation | `validateAssistantProposal` in `aiActions.ts` | works, rejects bad args |
| Confirmation contract | `V2Confirmation { required, preview }` | works |
| Execution | `executeAssistantProposal` | works |
| Accounting invariants | `invariants.ts` | works |
| Free-form answering | optional packs (Qwen 2.5 0.5B/1.5B, Phi-4 mini) | works, **no tools** |

The safety story is already better than a typical cloud agent: every write is a
*proposal* that must pass validation and then explicit user confirmation.

---

## 2. Phase 0 — the tool list Needle actually understands (DONE)

### What was wrong

`ledgrOnDeviceToolsJson` emitted an OpenAI-style object:

```json
{ "tools": [ { "type": "function", "function": { "name": "...", "description": "...",
  "parameters": { "type": "object", "additionalProperties": true } } } ],
  "partyHints": [], "date": "...", "rules": [] }
```

`needle_init(system_prompt, tools_json, tool_index_path)` rejected it, so
**every** call failed with `Needle could not load the Ledgr tool list`, which
surfaced in Ask AI as "Sorry, I couldn't answer that."

### How the shape was established

Not by guessing. `scripts/on-device-ai/ledgr-tools.json` is the tool list the
Needle weights were fine-tuned against, and it is a bare array of
`{name, parameters}` where `parameters` maps a field to a type name:

```json
[ {"name":"add_expense","parameters":{"category":"string","amount":"number",
   "date":"string","method":"string","notes":"string"}}, ... ]
```

Its 16 names match `LEDGR_ON_DEVICE_TOOL_NAMES` exactly, in order.

### What changed

- `ledgrOnDeviceToolsJson()` now emits exactly that array.
- `LEDGR_ON_DEVICE_TOOL_PARAMETERS` holds the same parameter maps, so the model
  is finally told what arguments each tool takes.
- The date, known parties and rules moved out of the tool argument and into the
  transcript, via `ledgrOnDeviceToolContext()`.
- `onDeviceToolContract.test.ts` asserts the runtime list stays **equal to the
  training file**, so the two cannot drift.

### Still unverified

Needle only runs on a device. The shape now matches the training data, which is
strong evidence, but **confirm on a real build before Phases 2–4 lean on it.**
Test: Ask AI → "Create customer Amit" → it should propose, not error.

---

## 3. Phase 1 — reads (the biggest single win)

**Problem.** All 16 on-device tools are writes. The assistant can record
"paid 100 to Amit" but cannot answer "how much does Amit owe?" — it has no tool
to look anything up. That is why it feels like it does not know the app.

**The read actions already exist and are already validated** in `aiActions.ts`:

- `report_query` — `{ report: profit_and_loss | balance_sheet | cash_flow | trial_balance, from, to }`
- `party_lookup` — `{ query, role? }`
- `inventory_profit` — `{ from, to }`

**Work.**

1. Add the three to `LEDGR_ON_DEVICE_TOOL_NAMES` and
   `LEDGR_ON_DEVICE_TOOL_PARAMETERS`.
2. Add them to `scripts/on-device-ai/ledgr-tools.json` **and regenerate the
   fine-tune** (`generate-needle-dataset.mjs`, `finetune-needle.mjs`). The drift
   test will fail until both sides match — that is the point.
3. Route read tool calls to the existing read handlers; return the result as
   text, not a proposal. Reads need no confirmation.

**Acceptance.** "What is my profit this month?" and "How much does Amit owe?"
answer from the ledger with no cloud call.

**Note.** Until the model is re-fine-tuned it will not reliably emit the new
tool names. Adding names to the runtime list alone is not enough.

---

## 4. Phase 2 — a bounded loop

Today: one transcript in, one tool call out, done. An agent needs read → act:

```
"Paid Amit"  ->  party_lookup("Amit")  ->  two matches  ->  ask which
             ->  create_supplier_payment(supplierName: "Amit Traders", ...)
```

**Work.** A loop in `runNeedleTools` with:

- a hard cap of **3** iterations,
- tool results fed back as `TOOL RESULT: ...` lines in the transcript,
- **stop as soon as a write tool is proposed** — the proposal goes to the
  confirmation UI, the loop does not continue past it,
- reads may chain; writes terminate.

**Acceptance.** Property test: no input produces more than 3 native calls, and
no write executes without passing through `validateAssistantProposal`.

---

## 5. Phase 3 — app self-knowledge

"What can you do?" is currently answered from a paragraph hardcoded in
`onDeviceAsk.ts`. It goes stale the moment a capability is toggled.

**Work.** A read tool `describe_capabilities` returning the enabled capability
packs from `utils/capabilities.ts` and one line each. The answer becomes a fact
about this book rather than a sentence in a prompt.

**Acceptance.** Turning off Payroll in Workspace capabilities changes what the
assistant says it can do.

---

## 6. Phase 4 — let the prose packs propose

Needle is small and grammar-constrained: excellent at *shape*, weak at intent on
unusual phrasing. Qwen/Phi are the reverse.

**Work.** For an utterance Needle declines, ask the installed pack to name a tool
and arguments in prose, then hand that back through Needle's grammar so the
result is still a structurally valid call. The pack never reaches
`executeAssistantProposal` directly.

**Depends on Phase 0 being confirmed on device.** Do not start until then.

---

## 7. The line that does not move

Every write stays behind `validateAssistantProposal` **and** explicit user
confirmation. "Agentic" here means the assistant does the looking-up and the
drafting; it does not mean it posts to the ledger unattended. The existing
architecture enforces this and no phase above relaxes it.

Reads are the exception and are safe: they cannot mutate the book.

---

## 8. Order, and why

1. **Phase 0** — done. Nothing else works until the tool list loads.
2. **Phase 1** — reads. Largest perceived-intelligence gain per line changed.
3. **Phase 2** — loop. Turns two capabilities into a conversation.
4. **Phase 3** — self-knowledge. Small, high polish.
5. **Phase 4** — pack routing. Most speculative; depends on device confirmation.

Phases 1–3 are testable under jest. Phase 0's runtime behaviour and Phase 4 need
a physical device.
