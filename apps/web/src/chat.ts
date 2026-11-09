import type { MessagePart, OutputMessage, TraceEvent } from "./types";

type EventPart = Extract<MessagePart, { kind: "event" }>;

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/** Trace events worth surfacing inline in the chat (safety, recovery and approval decisions). */
function inlineEvent(e: TraceEvent): Omit<EventPart, "kind"> | null {
  switch (e.type) {
    case "prompt_injection_withheld": {
      const n = Array.isArray(e.flagged) ? e.flagged.length : 1;
      return { event: "Prompt injection withheld", detail: `${n} field(s) from ${str(e.tool)} were removed before reaching the model`, tone: "warn" };
    }
    case "approval_gate_check": {
      const r = e.result as { ok?: boolean; reason?: string; message?: string } | undefined;
      return r?.ok
        ? { event: "Approval gate passed", detail: "provider, slot and price match what you confirmed", tone: "ok" }
        : { event: "Approval gate blocked", detail: `${str(r?.reason)}: ${str(r?.message)}`, tone: "danger" };
    }
    case "action_started":
      return { event: `Executing ${str(e.action_type)}`, detail: `idempotency key ${str(e.idempotency_key)} saved before the call`, tone: "info" };
    case "booking_outcome_ambiguous":
      return { event: "Booking timed out", detail: "outcome unknown — checking the provider's records before any retry", tone: "warn" };
    case "timeout_after_success_detected":
      return { event: "Timeout after success", detail: `provider records show ${str(e.booking_id)} was booked — not retrying`, tone: "ok" };
    case "timeout_not_booked":
      return { event: "Not booked after timeout", detail: `provider status ${str(e.status)} — retrying with the same idempotency key`, tone: "warn" };
    case "approval_superseded":
      return { event: "Confirmation cancelled", detail: "you replied with something other than yes/no", tone: "info" };
    case "approval_invalidated":
      return { event: "Approval invalidated", detail: str(e.reason).replace(/_/g, " "), tone: "warn" };
    case "rehold_no_material_change":
      return { event: "Hold expired and re-held", detail: "same provider, slot and price — your approval still applies", tone: "info" };
    case "duplicate_confirmation_ignored":
      return { event: "Repeated confirmation ignored", detail: "nothing was executed twice", tone: "info" };
    case "intent_classified":
      return e.relevant ? null : { event: "Intent gate", detail: `${str(e.intent)} — main agent not called`, tone: "info" };
    case "agent_exit":
      return /^limit_/.test(str(e.exit)) ? { event: "Limit reached", detail: str(e.exit).replace(/_/g, " "), tone: "danger" } : null;
    case "proactive_decision":
      return { event: "Provider event detected", detail: `${str(e.booking_id)}: ${str(e.decision).replace(/_/g, " ")}`, tone: "warn" };
    case "recovery_check":
      return { event: "Restart recovery", detail: `checking provider records for an interrupted ${str(e.action_type)}`, tone: "info" };
    default:
      return null;
  }
}

export function applyTrace(parts: MessagePart[], e: TraceEvent): MessagePart[] {
  if (e.type === "tool_call") {
    return [
      ...parts,
      {
        kind: "tool",
        seq: e.seq,
        name: str(e.tool),
        input: e.args,
        output: e.result,
        ok: e.ok === true,
        latencyMs: Number(e.latency_ms ?? 0),
        executedBy: e.executed_by === "application" ? "application" : "agent",
      },
    ];
  }
  const inline = inlineEvent(e);
  return inline ? [...parts, { kind: "event", ...inline }] : parts;
}

export function applyMessage(parts: MessagePart[], m: OutputMessage): MessagePart[] {
  switch (m.kind) {
    case "assistant":
      return [...parts, { kind: "text", text: m.text }];
    case "confirmation":
      return m.approval ? [...parts, { kind: "confirmation", approval: m.approval }] : [...parts, { kind: "system", text: m.text }];
    case "system":
      return [...parts, { kind: "system", text: m.text }];
    case "error":
      return [...parts, { kind: "error", message: m.text }];
    default:
      return parts;
  }
}

const time = (ts: string) => new Date(ts).toLocaleTimeString([], { hour12: false });

/** One-line summary of a trace event for the inspector. */
export function summarizeTrace(e: TraceEvent): string {
  switch (e.type) {
    case "tool_call": {
      const r = e.result as { error?: string } | undefined;
      return `${e.executed_by === "application" ? "app" : "agent"} · ${str(e.tool)} ${e.ok ? "ok" : `✗ ${str(r?.error)}`} · ${str(e.latency_ms)}ms`;
    }
    case "model_call":
      return `${str(e.purpose)} · ${str(e.model)} · ${str(e.input_tokens)}→${str(e.output_tokens)} tok · $${str(e.est_cost_usd)} · ${str(e.latency_ms)}ms`;
    case "state_transition":
      return `${str(e.from)} → ${str(e.to)}  (${str(e.reason)})`;
    case "context_sent": {
      const x = e.memories_excluded as Record<string, number> | undefined;
      const sent = Array.isArray(e.memories_sent) ? e.memories_sent.length : 0;
      return `${sent} memories sent · excluded: ${x?.forgotten ?? 0} forgotten, ${x?.inferred_unconfirmed ?? 0} unconfirmed, ${x?.other_scope ?? 0} other-scope · ~${str(e.total_tokens_est)}/${str(e.budget_tokens)} tok · ${str(e.history_messages_sent)} msgs`;
    }
    case "run_start":
      return `${str(e.trigger)}: ${str(e.input)}`;
    case "run_end":
      return `${str(e.outcome)} · ${str(e.wall_clock_ms)}ms · ${str(e.model_calls)} model / ${str(e.tool_calls)} tool calls · ${str(e.input_tokens)}→${str(e.output_tokens)} tok · $${str(e.est_cost_usd)}`;
    default: {
      const { ts: _ts, seq: _seq, run_id: _run, session_id: _sid, type: _type, ...rest } = e;
      const s = JSON.stringify(rest);
      return s === "{}" ? "" : s.length > 140 ? `${s.slice(0, 140)}…` : s;
    }
  }
}

export { time as traceTime };

export const TRACE_TONE: Record<string, "ok" | "warn" | "danger" | "info" | "muted"> = {
  tool_call: "info",
  model_call: "muted",
  context_sent: "muted",
  state_transition: "muted",
  run_start: "muted",
  run_end: "muted",
  prompt_injection_withheld: "warn",
  booking_outcome_ambiguous: "warn",
  timeout_after_success_detected: "ok",
  timeout_not_booked: "warn",
  action_succeeded: "ok",
  action_failed: "danger",
  approval_requested: "warn",
  approval_granted: "ok",
  approval_gate_check: "info",
  approval_invalidated: "danger",
  unexpected_error: "danger",
  model_error: "danger",
  proactive_decision: "warn",
  simulation_control: "warn",
};
