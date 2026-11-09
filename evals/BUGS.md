# Three real bugs hit while building

Each one is guarded by a test in `evals/regressions.test.ts`.

## BUG-1 — Trace events logged under the wrong type
- **What broke:** `action_started` and `recovery_check` events appeared in traces as type `"book"` / `"cancel"`, so the
  web UI's inline "Executing book" row never showed and trace filters missed them.
- **Why:** `Tracer.event(type, data)` built the line as `{ ..., type, ...data }`. Those events carried a `type` field
  in their data (the action type), which silently overwrote the event type.
- **Fix:** reserved fields (`ts`, `session_id`, `run_id`, `seq`, `type`) are applied after the data so they always win,
  and the callers now use `action_type`.
- **Regression test:** `BUG-1: event data cannot overwrite a trace event's own type/seq`.

## BUG-2 — Environment overrides silently ignored under `bun run dev`
- **What broke:** starting the web stack with `DATA_DIR=… bun run dev` wrote into the default `data/` folder, and
  `SEED_MEMORIES` / `MOCK_SEED` overrides had no effect.
- **Why:** Turborepo runs tasks in strict env mode and strips variables that aren't declared, so the server process
  never saw them.
- **Fix:** list every variable the apps read under `globalPassThroughEnv` in `turbo.json`.
- **Regression test:** `BUG-2: every env var the apps read is passed through by turbo` (scans the code for
  `process.env.X` and checks each one is passed through).

## BUG-3 — Web chat went blank as soon as a conversation started
- **What broke:** the whole page unmounted ("destroy is not a function") when the chat view opened.
- **Why:** the trace panel used `useEffect(() => end.current?.scrollIntoView(...))`. Current Chromium returns a Promise
  from `scrollIntoView`; the arrow function returned it, React treated it as the cleanup function and crashed calling it.
- **Fix:** effect bodies use braces so they never return a value.
- **Regression test:** `BUG-3: no useEffect callback returns a value` (scans `apps/web/src` for expression-bodied effects).
