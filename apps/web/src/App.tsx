import { Clock3, Hourglass, PanelRight, RotateCcw, Workflow } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, modelStore, streamSSE, type StreamHandlers } from "./api";
import { applyMessage, applyTrace } from "./chat";
import { ChatBar } from "./components/ChatBar";
import { Inspector } from "./components/Inspector";
import { MessageList } from "./components/MessageList";
import { SettingsMenu } from "./components/SettingsMenu";
import type { ChatMessage, Fixtures, Health, MessagePart, SessionSnapshot, TraceEvent } from "./types";

const PLACEHOLDER = "Book a plumber, move a booking, or cancel one...";
const POLL_MS = 3000;
const EXAMPLES = [
  "Find a plumber for my kitchen tap this week, mornings only, under ₹1,500.",
  "Move my AC servicing to Saturday.",
  "Book the same electrician as last time, but not before 10 a.m.",
];

const uid = () => Math.random().toString(36).slice(2, 10);

type Assistant = Extract<ChatMessage, { role: "assistant" }>;

function friendlyError(message: string): string {
  if (/authentication|invalid x-api-key|401/i.test(message)) return "Anthropic rejected the API key in .env.";
  if (/rate.?limit|429/i.test(message)) return "Anthropic rate limit hit. Wait a moment and try again.";
  if (/overloaded|529/i.test(message)) return "The model is overloaded right now. Try again or pick another model.";
  if (/failed to fetch|networkerror/i.test(message)) return "Can't reach the server. Is it running?";
  return message;
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [serverDown, setServerDown] = useState(false);
  const [fixtures, setFixtures] = useState<Fixtures | null>(null);
  const [model, setModel] = useState<string>(() => modelStore.get() ?? "");
  const [menuOpen, setMenuOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);
  const sessionId = useRef<string | null>(null);
  const sending = useRef(false);
  const polling = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .health()
      .then((h) => {
        setHealth(h);
        setModel((m) => (h.models.some((x) => x.id === m) ? m : h.default_model));
      })
      .catch(() => setServerDown(true));
    api.fixtures().then(setFixtures).catch(() => undefined);
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Pull the full trace after each turn (also picks up events written outside a stream, e.g. simulation controls).
  useEffect(() => {
    if (!sessionId.current) return;
    api
      .trace(sessionId.current)
      .then(({ events }) => setTrace(events))
      .catch(() => undefined);
  }, [refreshTick]);

  const update = (id: string, fn: (m: Assistant) => Partial<Assistant>) =>
    setMessages((ms) => ms.map((m) => (m.id === id && m.role === "assistant" ? { ...m, ...fn(m) } : m)));

  const addTrace = (e: TraceEvent) => setTrace((t) => (t.some((x) => x.seq === e.seq) ? t : [...t, e]));

  const handlersFor = (getId: () => string): StreamHandlers => ({
    onTrace: (e) => {
      addTrace(e);
      const id = getId();
      update(id, (m) => ({ parts: applyTrace(m.parts, e) }));
    },
    onMessage: (msg) => {
      const id = getId();
      update(id, (m) => ({ parts: applyMessage(m.parts, msg) }));
    },
    onSession: setSession,
  });

  const ensureSession = async (): Promise<string> => {
    if (sessionId.current) return sessionId.current;
    const { session: s, messages: notices } = await api.createSession();
    sessionId.current = s.session_id;
    setSession(s);
    setTrace([]);
    if (notices.length) {
      const parts = notices.reduce<MessagePart[]>(applyMessage, []);
      setMessages((ms) => [...ms, { id: uid(), role: "assistant", parts, streaming: false }]);
    }
    return s.session_id;
  };

  const send = async (text: string) => {
    if (sending.current) return;
    if (health && !health.has_api_key) {
      setMenuOpen(true);
      return;
    }
    sending.current = true;
    setStreaming(true);
    const assistantId = uid();
    setMessages((ms) => [...ms, { id: uid(), role: "user", text }, { id: assistantId, role: "assistant", parts: [], streaming: true }]);
    try {
      const id = await ensureSession();
      await streamSSE(`/api/sessions/${id}/messages`, { message: text, model }, handlersFor(() => assistantId));
    } catch (err) {
      if (err instanceof ApiError && err.code === "session_not_found") {
        sessionId.current = null;
        setMessages((ms) => [...ms, { id: uid(), role: "notice", text: "That conversation no longer exists on the server. Send your message again to start fresh." }]);
      }
      const message = err instanceof Error ? friendlyError(err.message) : String(err);
      update(assistantId, (m) => ({ parts: [...m.parts, { kind: "error", message }] }));
    } finally {
      update(assistantId, () => ({ streaming: false }));
      sending.current = false;
      setStreaming(false);
      setRefreshTick((t) => t + 1);
    }
  };

  // Proactive follow-up: ask the server for provider events without any user message.
  useEffect(() => {
    const timer = setInterval(async () => {
      const id = sessionId.current;
      if (!id || sending.current || polling.current) return;
      polling.current = true;
      let assistantId: string | null = null;
      const getId = () => {
        if (!assistantId) {
          const fresh = uid();
          assistantId = fresh;
          setMessages((ms) => [...ms, { id: fresh, role: "assistant", parts: [], streaming: true }]);
        }
        return assistantId;
      };
      try {
        await streamSSE(`/api/sessions/${id}/poll`, {}, { ...handlersFor(getId), onSession: (s) => assistantId && setSession(s) });
      } catch {
        // Server briefly unavailable (e.g. restarting); try again on the next tick.
      } finally {
        if (assistantId) {
          const done = assistantId;
          update(done, () => ({ streaming: false }));
          setRefreshTick((t) => t + 1);
        }
        polling.current = false;
      }
    }, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const newChat = useCallback(() => {
    sessionId.current = null;
    setMessages([]);
    setSession(null);
    setTrace([]);
  }, []);

  const changeModel = (id: string) => {
    setModel(id);
    modelStore.set(id);
  };

  const inChat = messages.length > 0;
  const chatBar = (docked: boolean) => (
    <ChatBar
      models={health?.models ?? []}
      model={model}
      onModelChange={changeModel}
      onSend={send}
      onStop={() => undefined}
      streaming={streaming}
      placeholder={PLACEHOLDER}
      docked={docked}
      autoFocus={docked}
    />
  );

  return (
    <div className="page">
      <div className="sky" aria-hidden />

      <SettingsMenu open={menuOpen} onOpenChange={setMenuOpen} health={health} fixtures={fixtures} onNewChat={newChat} />

      {!inChat ? (
        <main className="hero">
          <h1 className="hero__title">Errand Agent</h1>
          <p className="hero__subtitle">
            Plumbers, electricians and AC servicing in Bengaluru.
            <br />
            Compared, held and booked — only after you confirm.
          </p>
          <div className="hero__bar">{chatBar(false)}</div>
          <div className="hero__examples">
            {EXAMPLES.map((e) => (
              <button key={e} type="button" className="glass example" onClick={() => void send(e)}>
                {e}
              </button>
            ))}
          </div>
          {health && !health.has_api_key && (
            <button type="button" className="hero__keyhint" onClick={() => setMenuOpen(true)}>
              The server has no ANTHROPIC_API_KEY — add it to .env and restart
            </button>
          )}
          {serverDown && <p className="hero__keyhint">Can't reach the API server. Run bun run dev from the repo root.</p>}
        </main>
      ) : (
        <div className={`workspace ${inspectorOpen ? "workspace--split" : ""}`}>
          <main className="panel">
            <header className="panel__header">
              <span className="panel__title">Errand Agent</span>
              <div className="panel__status">
                <StatusChips session={session} />
                <button
                  type="button"
                  className={`icon-btn ${inspectorOpen ? "icon-btn--on" : ""}`}
                  onClick={() => setInspectorOpen((o) => !o)}
                  title="Inspector: trace, bookings, memory, simulation"
                  aria-label="Toggle inspector"
                >
                  <PanelRight size={15} />
                </button>
                <button type="button" className="icon-btn" onClick={newChat} title="New conversation" aria-label="New conversation">
                  <RotateCcw size={15} />
                </button>
              </div>
            </header>
            <div className="panel__scroll" ref={scroller}>
              <MessageList
                messages={messages}
                pendingApprovalId={session?.pending_approval?.id ?? null}
                busy={streaming}
                onAnswer={(a) => void send(a)}
              />
            </div>
            <div className="panel__bar">{chatBar(true)}</div>
          </main>
          {inspectorOpen && <Inspector trace={trace} session={session} fixtures={fixtures} refreshTick={refreshTick} onChanged={() => setRefreshTick((t) => t + 1)} onClose={() => setInspectorOpen(false)} />}
        </div>
      )}
    </div>
  );
}

function StatusChips({ session }: { session: SessionSnapshot | null }) {
  if (!session) return null;
  const hold = session.active_hold;
  const expires = hold ? new Date(hold.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
  return (
    <>
      <span className="chip" title="Workflow phase">
        <Workflow size={12} /> {session.phase.replace(/_/g, " ")}
      </span>
      {session.pending_approval ? (
        <span className="chip chip--warn">
          <Hourglass size={12} /> awaiting your confirmation
        </span>
      ) : hold ? (
        <span className="chip chip--ok" title={`${hold.hold_id} · ${hold.provider_name}`}>
          <Clock3 size={12} /> hold ₹{hold.quoted_price} until {expires}
        </span>
      ) : null}
    </>
  );
}
