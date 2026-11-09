import {
  AlertTriangle,
  BadgeCheck,
  BellRing,
  CalendarClock,
  CalendarX2,
  ChevronRight,
  Cog,
  Info,
  Loader2,
  Lock,
  Search,
  ShieldAlert,
  ShieldCheck,
  Store,
  UserRound,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import type { Approval, ChatMessage, MessagePart, ToolPart } from "../types";
import { Markdown } from "./Markdown";

type Props = {
  messages: ChatMessage[];
  pendingApprovalId: string | null;
  busy: boolean;
  onAnswer: (answer: "yes" | "no") => void;
};

export function MessageList({ messages, pendingApprovalId, busy, onAnswer }: Props) {
  return (
    <div className="messages">
      {messages.map((m) => {
        if (m.role === "user") {
          return (
            <div key={m.id} className="msg msg--user">
              <div className="bubble">{m.text}</div>
            </div>
          );
        }
        if (m.role === "notice") {
          return (
            <div key={m.id} className="notice">
              <Info size={13} /> {m.text}
            </div>
          );
        }
        return (
          <AssistantMessage
            key={m.id}
            parts={m.parts}
            streaming={m.streaming}
            pendingApprovalId={pendingApprovalId}
            busy={busy}
            onAnswer={onAnswer}
          />
        );
      })}
    </div>
  );
}

function AssistantMessage({
  parts,
  streaming,
  pendingApprovalId,
  busy,
  onAnswer,
}: { parts: MessagePart[]; streaming: boolean } & Omit<Props, "messages">) {
  const hasText = parts.some((p) => p.kind === "text" && p.text.trim());
  return (
    <div className="msg msg--agent">
      <div className="avatar" aria-hidden>
        E
      </div>
      <div className="agent-body">
        {parts.map((p, i) => (
          <Part key={i} part={p} active={p.kind === "confirmation" && p.approval.id === pendingApprovalId && !busy} onAnswer={onAnswer} />
        ))}
        {streaming && (
          <div className="thinking">
            <Loader2 size={13} className="spin" /> {hasText ? "Working" : "Thinking"}
          </div>
        )}
      </div>
    </div>
  );
}

function Part({ part, active, onAnswer }: { part: MessagePart; active: boolean; onAnswer: Props["onAnswer"] }) {
  switch (part.kind) {
    case "text":
      return part.text.trim() ? (
        <div className="agent-text">
          <Markdown text={part.text} />
        </div>
      ) : null;
    case "tool":
      return <ToolRow part={part} />;
    case "event":
      return (
        <div className={`activity activity--event activity--${part.tone}`}>
          {part.tone === "ok" ? <ShieldCheck size={14} /> : part.tone === "danger" ? <ShieldAlert size={14} /> : part.tone === "warn" ? <AlertTriangle size={14} /> : <Info size={14} />}
          <span className="activity__label">{part.event}</span>
          {part.detail && <span className="activity__detail">{part.detail}</span>}
        </div>
      );
    case "confirmation":
      return <ConfirmationCard approval={part.approval} active={active} onAnswer={onAnswer} />;
    case "system":
      return (
        <div className="sysnote">
          <BellRing size={15} />
          <span>{part.text}</span>
        </div>
      );
    case "error":
      return (
        <div className="activity activity--error">
          <AlertTriangle size={14} />
          <span>{part.message}</span>
        </div>
      );
  }
}

const fmtSlot = (dt?: string) => {
  if (!dt) return "";
  const [date, time] = dt.split("T");
  const d = new Date(`${date}T00:00:00`);
  return `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}, ${time}`;
};

const fmtClock = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "");

function ConfirmationCard({ approval, active, onAnswer }: { approval: Approval; active: boolean; onAnswer: Props["onAnswer"] }) {
  const d = approval.details;
  const priceChanged = d.search_price !== undefined && d.price !== undefined && d.search_price !== d.price;
  const title = approval.action === "book" ? "Confirm booking" : approval.action === "cancel" ? "Confirm cancellation" : "Confirm reschedule";
  const Icon = approval.action === "book" ? CalendarClock : approval.action === "cancel" ? CalendarX2 : CalendarClock;
  return (
    <div className={`confirm ${active ? "" : "confirm--closed"}`}>
      <div className="confirm__head">
        <Icon size={16} />
        <span>{title}</span>
        <span className="mono confirm__id">{approval.id}</span>
      </div>
      <dl className="confirm__grid">
        <dt>Provider</dt>
        <dd>
          {d.provider_name} <span className="mono muted">{d.provider_id}</span>
        </dd>
        <dt>Service</dt>
        <dd>{d.service.replace(/_/g, " ")}</dd>
        {approval.action === "reschedule" ? (
          <>
            <dt>From</dt>
            <dd>{fmtSlot(d.old_slot)}</dd>
            <dt>To</dt>
            <dd className="strong">{fmtSlot(d.new_slot)}</dd>
          </>
        ) : (
          <>
            <dt>Slot</dt>
            <dd className="strong">{fmtSlot(d.slot)}</dd>
          </>
        )}
        {d.booking_id && (
          <>
            <dt>Booking</dt>
            <dd className="mono">{d.booking_id}</dd>
          </>
        )}
        {d.price !== undefined && approval.action === "book" && (
          <>
            <dt>Price</dt>
            <dd className="strong">
              ₹{d.price}
              {priceChanged && <span className="tag tag--warn confirm__changed">listed at ₹{d.search_price} — changed at hold</span>}
            </dd>
          </>
        )}
        {d.hold_id && (
          <>
            <dt>Hold</dt>
            <dd>
              <span className="mono">{d.hold_id}</span> <span className="muted">expires {fmtClock(d.hold_expires_at)}</span>
            </dd>
          </>
        )}
      </dl>
      {active ? (
        <div className="confirm__actions">
          <button type="button" className="confirm__yes" onClick={() => onAnswer("yes")}>
            Yes, {approval.action}
          </button>
          <button type="button" className="confirm__no" onClick={() => onAnswer("no")}>
            No
          </button>
          <span className="confirm__fine">
            <Lock size={11} /> Nothing happens until you confirm. Any other message cancels this.
          </span>
        </div>
      ) : (
        <div className="confirm__fine confirm__fine--closed">No longer awaiting a reply</div>
      )}
    </div>
  );
}

function ToolRow({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const { label, Icon } = describeTool(part);
  const tone = part.ok ? (part.executedBy === "application" ? "app" : "neutral") : "error";
  return (
    <div className={`activity activity--tool activity--${tone}`}>
      <button type="button" className="activity__toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon size={14} />
        <span className="activity__text">{label}</span>
        <span className={`who who--${part.executedBy}`}>{part.executedBy === "application" ? "app" : "agent"}</span>
        <span className="mono activity__name">
          {part.name} · {part.latencyMs}ms
        </span>
        <ChevronRight size={14} className={`activity__chevron ${open ? "is-open" : ""}`} />
      </button>
      {open && (
        <div className="activity__json">
          <div>
            <span className="activity__json-label">input</span>
            <pre>{JSON.stringify(part.input, null, 2)}</pre>
          </div>
          <div>
            <span className="activity__json-label">output</span>
            <pre>{JSON.stringify(part.output, null, 2)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function describeTool(part: ToolPart): { label: string; Icon: typeof Wrench } {
  const out = (part.output ?? {}) as Record<string, any>;
  const input = (part.input ?? {}) as Record<string, any>;
  if (!part.ok) return { label: `${part.name} failed: ${String(out.error ?? "error")}${out.message ? ` — ${out.message}` : ""}`, Icon: AlertTriangle };
  const data = out.data ?? out;
  switch (part.name) {
    case "update_request":
      return { label: "Noted request details", Icon: Cog };
    case "search_providers":
      return { label: `Found ${data.count ?? "?"} ${String(data.service ?? input.service ?? "").replace(/_/g, " ")} providers in ${data.area ?? input.area}`, Icon: Search };
    case "get_provider":
      return { label: `Checked ${data.name ?? input.provider_id} details & reviews`, Icon: Store };
    case "hold_slot":
      return { label: `Held ${data.slot_label ?? input.slot} · ₹${data.quoted_price}${data.price_changed ? ` (listed ₹${data.search_price})` : ""}`, Icon: Lock };
    case "list_bookings":
      return { label: `Looked up bookings (${data.count ?? "?"})`, Icon: CalendarClock };
    case "get_booking_status":
      return { label: `Booking status: ${data.status ?? out.status}`, Icon: BadgeCheck };
    case "request_approval":
      return { label: "Asked you to confirm", Icon: UserRound };
    case "book":
      return { label: `Booked ${out.booking_id}`, Icon: BadgeCheck };
    case "cancel":
      return { label: `Cancelled ${input.booking_id}`, Icon: CalendarX2 };
    case "reschedule":
      return { label: `Rescheduled ${input.booking_id}`, Icon: CalendarClock };
    case "save_memory":
      return { label: `Remembered ${out.scope}.${out.key}${out.visible_to_agent ? "" : " (inferred, needs confirmation)"}`, Icon: Cog };
    case "forget_memory":
      return { label: `Forgot ${(out.forgotten ?? []).join(", ") || "nothing"}`, Icon: Cog };
    case "list_memories":
      return { label: "Read saved preferences", Icon: Cog };
    default:
      return { label: part.name, Icon: Wrench };
  }
}
