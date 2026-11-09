# Design note — Errand Agent

**Shape.** One Claude agent (plain Anthropic Messages API + tools) inside a deterministic application shell. A cheap
Haiku intent gate screens the first message; the Sonnet agent understands requests and calls read-only tools; every
side effect (book / cancel / reschedule) is executed by application code. No framework: the safety rules need to own
the loop, and a thin `LLMClient` seam lets evals swap in a scripted model.

**State model.** Each session is a JSON file holding the Anthropic message history, a transcript and an explicit
workflow state: `phase` (`idle → collecting → searching → holding → awaiting_approval → executing → done | failed`),
the structured `request` (service, area, dates, time window, budget — merged field-by-field so a correction keeps
everything else), the `active_hold` and the `pending_approval_id`. Code moves the phase on tool results and approval
events; every transition is traced. Durable cross-session records live separately: `actions.json` (approvals + actions
+ idempotency keys), `memory.json`, and the mock provider's own state file.

**Approval enforcement.** The model has no `book`/`cancel`/`reschedule` tools — only `request_approval`. The
application builds the confirmation from the provider's authoritative hold/booking record (never from model arguments)
and stores an approval `{provider, slot, price, hold}`. "yes"/"no" is matched by a regex in code; any other reply
supersedes the approval. Immediately before executing, the gate re-reads the hold and blocks on any difference in
provider, slot or price, or an expired hold. An expired hold is re-held: same price → proceed, new price → fresh card.

**Idempotency and recovery.** The key is derived from the approval (`book_<approval_id>`) and written to the ledger
*before* the call. On `timeout` the executor asks `get_booking_status(key)` before anything else; it retries with the
same key only if the provider says not booked, up to 3 attempts, then reports "nothing was booked". `slot_taken` and
`slot_conflict` hand control back to the agent with an application note — never an automatic rebook. Repeated "yes"
hits the consumed approval and is ignored. On startup any action still `executing` is resolved from the provider's
records (restart mid-booking). `cancel` retries its transient 503 with the same key. Success is claimed only after
`get_booking_status`/`list_bookings` confirms it.

**Memory.** Facts are `explicit` (user said it) or `inferred` (agent's guess, hidden until the user confirms). Users can
list, edit, confirm and forget (forgetting erases the value). Per turn the context builder sends only active,
explicit-or-confirmed facts scoped to `global` or the current service, within an 800-token memory budget and a
12k total budget (oldest turns trimmed; the workflow state keeps the facts). Each turn logs what was sent and why the
rest was excluded.

**Untrusted output & limits.** Tool results are wrapped as untrusted data; free text matching injection patterns is
withheld before it reaches the model and logged. Per run: ≤10 model calls, ≤20 tool calls, ≤120 s; each exit path
returns a user-facing message.

**Observability.** One JSONL trace per session: run start/end, state transitions, context sent, model calls (latency,
tokens, estimated cost), tool calls (args, sanitized result, latency, agent vs application), approval and recovery
events. Excerpt from a real run ([full file](../evals/artifacts/timeout-after-success.real-claude.trace.jsonl)):

```text
seq 26  simulation_control       force_book_outcome=timeout_booked      ← demo control: provider will time out after booking
seq 28  confirmation_reply       decision=yes                           ← user's "yes", matched by code
seq 31  approval_gate_check      ok                                     ← P3 / 10 Nov 08:00 / ₹520 still matches the hold
seq 32  action_started           key=book_apr_e0dcbd5209                ← key persisted before the side effect
seq 33  tool_call book           FAILED timeout · 1328 ms               ← outcome unknown
seq 34  booking_outcome_ambiguous                                       ← no blind retry
seq 35  tool_call get_booking_status  confirmed B-1004 · 121 ms         ← ask the source of truth
seq 36  timeout_after_success_detected  B-1004                          ← it did book: do not retry
seq 37  action_succeeded         verified_via=get_booking_status_after_timeout
seq 42  duplicate_confirmation_ignored                                  ← later "yes" → no second booking
```

**Trade-offs.** JSON files with atomic writes instead of a database: zero setup and inspectable, at the cost of
single-process concurrency. A single agent: the hard problems here are correctness, not reasoning breadth, so a second
agent would add cost without fixing anything. A regex for yes/no is strict and occasionally re-asks, which we prefer to
an LLM deciding consent. The mock is a seeded, persisted "remote service", so every failure is reproducible in evals.
