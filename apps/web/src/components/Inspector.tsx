import { Activity, Brain, CalendarDays, FlaskConical, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { summarizeTrace, TRACE_TONE, traceTime } from "../chat";
import type { Booking, Fixtures, MemoryItem, SessionSnapshot, SimState, TraceEvent } from "../types";

type Tab = "trace" | "bookings" | "memory" | "simulate";

type Props = {
  trace: TraceEvent[];
  session: SessionSnapshot | null;
  fixtures: Fixtures | null;
  refreshTick: number;
  onChanged: () => void;
  onClose: () => void;
};

export function Inspector({ trace, session, fixtures, refreshTick, onChanged, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("trace");
  const tabs: { id: Tab; label: string; Icon: typeof Activity }[] = [
    { id: "trace", label: "Trace", Icon: Activity },
    { id: "bookings", label: "Bookings", Icon: CalendarDays },
    { id: "memory", label: "Memory", Icon: Brain },
    { id: "simulate", label: "Simulate", Icon: FlaskConical },
  ];
  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="inspector__tabs" role="tablist">
        {tabs.map(({ id, label, Icon }) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className="inspector__tab" onClick={() => setTab(id)}>
            <Icon size={14} /> {label}
          </button>
        ))}
        <button type="button" className="icon-btn inspector__close" onClick={onClose} aria-label="Close inspector">
          <X size={15} />
        </button>
      </div>
      <div className="inspector__body">
        {tab === "trace" && <TraceTab trace={trace} session={session} />}
        {tab === "bookings" && <BookingsTab refreshTick={refreshTick} sessionId={session?.session_id} onChanged={onChanged} />}
        {tab === "memory" && <MemoryTab refreshTick={refreshTick} sessionId={session?.session_id} onChanged={onChanged} />}
        {tab === "simulate" && <SimulateTab fixtures={fixtures} sessionId={session?.session_id} refreshTick={refreshTick} onChanged={onChanged} />}
      </div>
    </aside>
  );
}

function TraceTab({ trace, session }: { trace: TraceEvent[]; session: SessionSnapshot | null }) {
  const [verbose, setVerbose] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => (verbose ? trace : trace.filter((e) => !["context_sent", "model_call"].includes(e.type))), [trace, verbose]);
  const lastRun = [...trace].reverse().find((e) => e.type === "run_end");

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [shown.length]);

  return (
    <div className="itab">
      <div className="itab__bar">
        <label className="toggle">
          <input type="checkbox" checked={verbose} onChange={(e) => setVerbose(e.target.checked)} /> context & model calls
        </label>
        <span className="muted small">{trace.length} events</span>
      </div>
      {lastRun && <div className="trace__totals">Last run: {summarizeTrace(lastRun)}</div>}
      {session && (
        <div className="trace__file mono" title={session.trace_file}>
          {session.trace_file.split("/data/")[1] ?? session.trace_file}
        </div>
      )}
      <ol className="trace">
        {shown.map((e) => (
          <li key={e.seq} className={`trace__row trace__row--${TRACE_TONE[e.type] ?? "plain"} ${e.type === "run_start" ? "trace__row--run" : ""}`}>
            <button type="button" className="trace__head" onClick={() => setOpen(open === e.seq ? null : e.seq)}>
              <span className="trace__seq mono">{e.seq}</span>
              <span className="trace__time mono">{traceTime(e.ts)}</span>
              <span className="trace__type mono">{e.type}</span>
              <span className="trace__sum">{summarizeTrace(e)}</span>
            </button>
            {open === e.seq && <pre className="trace__json">{JSON.stringify(e, null, 2)}</pre>}
          </li>
        ))}
      </ol>
      {!trace.length && <p className="muted small">Trace events appear here as the agent works.</p>}
      <div ref={end} />
    </div>
  );
}

function useLoader<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () =>
    load()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, reload };
}

const statusTone = (s: string) => (s === "confirmed" ? "ok" : s.startsWith("cancelled") ? "danger" : "");

function BookingsTab({ refreshTick, sessionId, onChanged }: { refreshTick: number; sessionId?: string; onChanged: () => void }) {
  const { data, error, reload } = useLoader(() => api.bookings(), [refreshTick]);
  const [msg, setMsg] = useState<string | null>(null);
  const cancel = async (b: Booking) => {
    try {
      await api.providerCancel(b.booking_id, sessionId);
      setMsg(`${b.provider_name} cancelled ${b.booking_id}. The agent will notice within a few seconds.`);
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <div className="itab">
      <div className="itab__bar">
        <span className="small muted">Source of truth: the mock provider</span>
        <button type="button" className="icon-btn" onClick={() => void reload()} aria-label="Refresh">
          <RefreshCw size={14} />
        </button>
      </div>
      {msg && <div className="itab__msg">{msg}</div>}
      {error && <div className="itab__msg itab__msg--error">{error}</div>}
      <ul className="cards">
        {data?.bookings.map((b) => (
          <li key={b.booking_id} className="card">
            <div className="card__row">
              <span className="mono strong">{b.booking_id}</span>
              <span className={`tag ${statusTone(b.status) === "ok" ? "tag--ok" : statusTone(b.status) === "danger" ? "tag--danger" : ""}`}>{b.status.replace(/_/g, " ")}</span>
              <span className="tag">{b.when}</span>
            </div>
            <div className="card__title">
              {b.provider_name} · {b.service.replace(/_/g, " ")}
            </div>
            <div className="card__meta">
              {b.slot_label} · ₹{b.price}
            </div>
            {b.status === "confirmed" && b.when === "upcoming" && (
              <button type="button" className="mini-btn mini-btn--warn" onClick={() => void cancel(b)}>
                Simulate provider cancelling
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MemoryTab({ refreshTick, sessionId, onChanged }: { refreshTick: number; sessionId?: string; onChanged: () => void }) {
  const [all, setAll] = useState(false);
  const { data, error, reload } = useLoader(() => api.memory(all), [refreshTick, all]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const act = (p: Promise<unknown>) => p.then(() => onChanged()).catch(() => undefined);

  const items = data?.items ?? [];
  const usable = items.filter((m) => m.status === "active" && (m.source === "explicit" || m.confirmed)).length;

  return (
    <div className="itab">
      <div className="itab__bar">
        <label className="toggle">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> show forgotten
        </label>
        <span className="small muted">
          {usable} usable / {items.length} shown
        </span>
      </div>
      <p className="small muted">Only explicit and confirmed facts can reach the model, and only when relevant to the current service.</p>
      {error && <div className="itab__msg itab__msg--error">{error}</div>}
      <ul className="mem">
        {items.map((m: MemoryItem) => {
          const tag = m.status === "forgotten" ? ["forgotten", "danger"] : m.source === "explicit" ? ["explicit", "ok"] : m.confirmed ? ["inferred ✓", "ok"] : ["inferred ?", "warn"];
          return (
            <li key={m.id} className={`mem__row ${m.status === "forgotten" ? "mem__row--gone" : ""}`}>
              <div className="mem__main">
                <span className="mono mem__key">
                  {m.scope}.{m.key}
                </span>
                <span className={`tag tag--${tag[1]}`}>{tag[0]}</span>
              </div>
              {editing === m.id ? (
                <form
                  className="mem__edit"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (draft.trim()) void act(api.editMemory(m.id, draft.trim(), sessionId));
                    setEditing(null);
                  }}
                >
                  <input value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus aria-label={`New value for ${m.key}`} />
                  <button type="submit" className="mini-btn">
                    Save
                  </button>
                </form>
              ) : (
                <div className="mem__value">{m.value || <span className="muted">(erased)</span>}</div>
              )}
              {m.status === "active" && editing !== m.id && (
                <div className="mem__actions">
                  {m.source === "inferred" && !m.confirmed && (
                    <button type="button" className="mini-btn" onClick={() => void act(api.confirmMemory(m.id, sessionId))}>
                      Confirm
                    </button>
                  )}
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={() => {
                      setEditing(m.id);
                      setDraft(m.value);
                    }}
                  >
                    Edit
                  </button>
                  <button type="button" className="mini-btn mini-btn--danger" onClick={() => void act(api.forgetMemory(m.id, sessionId))}>
                    <Trash2 size={11} /> Forget
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const OUTCOME_LABELS: Record<string, { label: string; hint: string }> = {
  success: { label: "Success", hint: "books normally" },
  slot_taken: { label: "Slot taken", hint: "someone else got the slot" },
  timeout_booked: { label: "Timeout after success", hint: "times out but did book" },
  timeout_not_booked: { label: "Timeout, not booked", hint: "times out and did not book" },
};

function SimulateTab({ fixtures, sessionId, refreshTick, onChanged }: { fixtures: Fixtures | null; sessionId?: string; refreshTick: number; onChanged: () => void }) {
  const sim = useLoader(() => api.sim(), [refreshTick]);
  const bookings = useLoader(() => api.bookings(), [refreshTick]);
  const [pct, setPct] = useState<Record<string, string>>({});
  const [cancelId, setCancelId] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const run = async (p: Promise<unknown>, okMsg: string) => {
    try {
      await p;
      setMsg(okMsg);
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const queued = sim.data?.queued_book_outcomes ?? [];
  const upcoming = (bookings.data?.bookings ?? []).filter((b) => b.status === "confirmed" && b.when === "upcoming");

  return (
    <div className="itab">
      <p className="small muted">These controls change how the fake provider behaves. Users never see them — they make failures reproducible for demos.</p>
      {msg && <div className="itab__msg">{msg}</div>}

      <section className="sim">
        <h3>Next booking outcome</h3>
        <p className="small muted">Click before saying “yes” to a booking. Queued outcomes are used in order.</p>
        <div className="sim__grid">
          {(sim.data?.book_outcomes ?? Object.keys(OUTCOME_LABELS)).map((o) => (
            <button key={o} type="button" className={`sim__btn sim__btn--${o}`} onClick={() => void run(api.forceBook(o, sessionId), `Queued: ${OUTCOME_LABELS[o]?.label ?? o}`)}>
              <span>{OUTCOME_LABELS[o]?.label ?? o}</span>
              <small>{OUTCOME_LABELS[o]?.hint}</small>
            </button>
          ))}
        </div>
        <div className="sim__queue">
          <span className="small">Queue:</span>
          {queued.length ? queued.map((q, i) => <span key={i} className="tag tag--warn">{OUTCOME_LABELS[q]?.label ?? q}</span>) : <span className="small muted">empty (random: 70% success / 15% slot taken / 15% timeout)</span>}
          {queued.length > 0 && (
            <button type="button" className="mini-btn" onClick={() => void run(api.clearForced(), "Queue cleared")}>
              Clear
            </button>
          )}
        </div>
      </section>

      <section className="sim">
        <h3>Provider cancels a booking</h3>
        <p className="small muted">The agent detects it on its own (no message needed), finds a replacement and asks for fresh approval.</p>
        <div className="sim__row">
          <select value={cancelId} onChange={(e) => setCancelId(e.target.value)} aria-label="Booking to cancel">
            <option value="">Select upcoming booking…</option>
            {upcoming.map((b) => (
              <option key={b.booking_id} value={b.booking_id}>
                {b.booking_id} · {b.provider_name} · {b.slot_label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="mini-btn mini-btn--warn"
            disabled={!cancelId}
            onClick={() => void run(api.providerCancel(cancelId, sessionId), `Provider cancelled ${cancelId}. Watch the chat…`).then(() => setCancelId(""))}
          >
            Cancel it
          </button>
        </div>
      </section>

      <section className="sim">
        <h3>Price change when a slot is held</h3>
        <p className="small muted">The held price differs from the search price, so the confirmation shows the new price.</p>
        <ul className="sim__prices">
          {fixtures?.providers.map((p) => {
            const current = sim.data?.price_change_on_hold[p.id] ?? 0;
            return (
              <li key={p.id}>
                <span className="mono">{p.id}</span>
                <span className="sim__pname">{p.name}</span>
                <input
                  type="number"
                  step="0.05"
                  value={pct[p.id] ?? String(current)}
                  onChange={(e) => setPct((s) => ({ ...s, [p.id]: e.target.value }))}
                  aria-label={`Price change for ${p.name}`}
                />
                <button type="button" className="mini-btn" onClick={() => void run(api.priceChange(p.id, Number(pct[p.id] ?? current), sessionId), `${p.id} hold price change set to ${pct[p.id] ?? current}`)}>
                  Set
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="sim">
        <h3>Built-in behaviours</h3>
        <ul className="small sim__notes">
          <li>
            <b>Reschedule conflict:</b> picking a {fixtures?.reschedule_conflict_times.join(" or ")} slot returns slot_conflict.
          </li>
          <li>
            <b>Cancel:</b> the first cancel call always fails with a transient 503; the app retries with the same key.
          </li>
          <li>
            <b>Prompt injection:</b> {fixtures?.providers.find((p) => p.has_injection_review)?.name} has a malicious review — ask the agent to show its reviews.
          </li>
          <li>
            <b>Restart mid-booking:</b> queue “Timeout after success”, say yes, then stop the server within ~1s and restart it. The next poll reports the recovered booking.
          </li>
        </ul>
      </section>
    </div>
  );
}
