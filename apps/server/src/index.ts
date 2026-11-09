import express, { type Request, type Response } from "express";
import { AREAS, ErrandApp, PROVIDERS, config, createDeps, type ForcedBookOutcome, type OutputMessage, type RunHooks } from "@core";

const PORT = Number(process.env.PORT ?? 3001);

const MODELS = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
];
if (!MODELS.some((m) => m.id === config.agentModel)) MODELS.unshift({ id: config.agentModel, label: config.agentModel });

const BOOK_OUTCOMES: ForcedBookOutcome[] = ["success", "slot_taken", "timeout_booked", "timeout_not_booked"];

// One shared set of stores: every session talks to the same mock provider, ledger and memory.
const deps = createDeps();

interface Entry {
  app: ErrandApp;
  queue: Promise<unknown>;
  notices: OutputMessage[];
}
const entries = new Map<string, Entry>();

async function open(sessionId?: string): Promise<Entry | undefined> {
  if (sessionId && !deps.sessions.get(sessionId)) return undefined;
  const app = new ErrandApp(deps, sessionId ? { sessionId } : {});
  const entry: Entry = { app, queue: Promise.resolve(), notices: [] };
  entries.set(app.session.id, entry);
  // Resolves bookings interrupted by a server restart; messages are delivered on the next stream.
  entry.notices = await app.startup();
  return entry;
}

async function getEntry(sessionId: string | undefined): Promise<Entry | undefined> {
  if (!sessionId) return undefined;
  return entries.get(sessionId) ?? open(sessionId);
}

/** Serialise work per session so a chat turn and a background poll never interleave. */
function lock<T>(entry: Entry, fn: () => Promise<T>): Promise<T> {
  const run = entry.queue.then(fn, fn);
  entry.queue = run.catch(() => undefined);
  return run;
}

function sse(res: Response) {
  res.status(200).set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  return (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Streams trace events and user-facing messages while `fn` runs, then the final session snapshot. */
async function stream(entry: Entry, res: Response, fn: (hooks: RunHooks) => Promise<unknown>) {
  const send = sse(res);
  await lock(entry, async () => {
    const unsubscribe = entry.app.tracer.subscribe((e) => send("trace", e));
    try {
      for (const n of entry.notices.splice(0)) send("message", n);
      await fn({ onOutput: (m) => send("message", m) });
    } catch (err) {
      send("message", { kind: "error", text: (err as Error).message });
    } finally {
      unsubscribe();
      send("session", entry.app.snapshot());
      send("done", {});
      res.end();
    }
  });
}

const notFound = (res: Response) => res.status(404).json({ error: "session_not_found" });
const bad = (res: Response, message: string) => res.status(400).json({ error: "bad_request", message });

const app = express();
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    has_api_key: !!config.apiKey,
    default_model: config.agentModel,
    intent_model: config.intentModel,
    models: MODELS,
    user_id: config.userId,
  });
});

app.get("/api/fixtures", (_req, res) => {
  res.json({
    areas: AREAS,
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      name: p.name,
      services: p.services,
      rating: p.rating,
      areas: p.areas,
      price_change_on_hold: config.mock.priceChangeOnHold[p.id] ?? 0,
      has_injection_review: p.reviews.some((r) => /ignore all previous instructions/i.test(r.text)),
    })),
    reschedule_conflict_times: config.mock.rescheduleConflictTimes,
  });
});

app.post("/api/sessions", async (_req, res) => {
  const entry = (await open())!;
  res.json({ session: entry.app.snapshot(), messages: entry.notices.splice(0) });
});

app.get("/api/sessions/:id", async (req, res) => {
  const entry = await getEntry(req.params.id);
  if (!entry) return notFound(res);
  res.json({ session: entry.app.snapshot(), transcript: entry.app.session.transcript });
});

app.get("/api/sessions/:id/trace", async (req, res) => {
  const entry = await getEntry(req.params.id);
  if (!entry) return notFound(res);
  res.json({ events: entry.app.tracer.readAll() });
});

app.post("/api/sessions/:id/messages", async (req: Request, res: Response) => {
  const entry = await getEntry(req.params.id as string);
  if (!entry) return notFound(res);
  const message = String(req.body?.message ?? "").trim();
  if (!message) return bad(res, "message is required");
  if (!config.apiKey) return res.status(400).json({ error: "missing_api_key", message: "Set ANTHROPIC_API_KEY in .env and restart the server." });
  const model = MODELS.find((m) => m.id === req.body?.model)?.id;
  await stream(entry, res, (hooks) => {
    entry.app.model = model;
    return entry.app.handleUserMessage(message, hooks);
  });
});

/** Proactive follow-up: the browser polls this; provider events are detected without any user message. */
app.post("/api/sessions/:id/poll", async (req, res) => {
  const entry = await getEntry(req.params.id);
  if (!entry) return notFound(res);
  await stream(entry, res, (hooks) => entry.app.pollEvents(hooks));
});

app.get("/api/bookings", async (_req, res) => {
  res.json({ bookings: (await deps.provider.list_bookings({ user_id: config.userId })).bookings });
});

app.get("/api/memory", (req, res) => {
  res.json({ items: deps.memory.all(config.userId, { includeForgotten: req.query.all === "1" }) });
});

async function appFromBody(req: Request) {
  return (await getEntry(req.body?.session_id))?.app;
}

app.post("/api/memory/:id/forget", async (req, res) => {
  const app = await appFromBody(req);
  const removed = app ? app.forgetMemory(req.params.id) : deps.memory.forget(config.userId, req.params.id);
  res.json({ removed });
});

app.post("/api/memory/:id/confirm", async (req, res) => {
  const app = await appFromBody(req);
  const item = app ? app.confirmMemory(req.params.id) : deps.memory.confirm(config.userId, req.params.id);
  if (!item) return bad(res, "memory not found");
  res.json({ item });
});

app.patch("/api/memory/:id", async (req, res) => {
  const value = String(req.body?.value ?? "").trim();
  if (!value) return bad(res, "value is required");
  const app = await appFromBody(req);
  const item = app ? app.editMemory(req.params.id, value) : deps.memory.edit(config.userId, req.params.id, value);
  if (!item) return bad(res, "memory not found");
  res.json({ item });
});

app.get("/api/sim", (_req, res) => {
  res.json({ ...deps.provider.simulationState(), book_outcomes: BOOK_OUTCOMES });
});

app.post("/api/sim/force-book", async (req, res) => {
  const outcome = req.body?.outcome as ForcedBookOutcome;
  if (!BOOK_OUTCOMES.includes(outcome)) return bad(res, `outcome must be one of ${BOOK_OUTCOMES.join(", ")}`);
  const app = await appFromBody(req);
  if (app) app.forceNextBookOutcome(outcome);
  else deps.provider.forceNextBookOutcome(outcome);
  res.json(deps.provider.simulationState());
});

app.delete("/api/sim/force-book", (_req, res) => {
  deps.provider.clearForcedBookOutcomes();
  res.json(deps.provider.simulationState());
});

app.post("/api/sim/price-change", async (req, res) => {
  const providerId = String(req.body?.provider_id ?? "").toUpperCase();
  const pct = Number(req.body?.pct);
  if (!PROVIDERS.some((p) => p.id === providerId) || Number.isNaN(pct)) return bad(res, "provider_id and numeric pct are required");
  const app = await appFromBody(req);
  if (app) app.setPriceChange(providerId, pct);
  else deps.provider.setPriceChangeOnHold(providerId, pct);
  res.json(deps.provider.simulationState());
});

app.post("/api/sim/provider-cancel", async (req, res) => {
  const bookingId = String(req.body?.booking_id ?? "");
  try {
    const app = await appFromBody(req);
    const event = app ? app.simulateProviderCancel(bookingId) : deps.provider.simulateProviderCancel(bookingId);
    res.json({ event });
  } catch (err) {
    bad(res, (err as Error).message);
  }
});

app.listen(PORT, () => {
  console.log(`Errand Agent API on http://localhost:${PORT}  (model ${config.agentModel}, api key ${config.apiKey ? "set" : "MISSING"})`);
});
