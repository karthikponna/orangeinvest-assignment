import { runAgent } from "./agent/agentLoop";
import { AnthropicLLMClient, type LLMClient } from "./agent/llm";
import { setPhase } from "./agent/tools";
import { ApprovalGate, classifyConfirmation, renderApprovalPrompt } from "./approval/approvalGate";
import { config } from "./config";
import { ActionExecutor } from "./executor/actionExecutor";
import { classifyIntent } from "./intent/classifier";
import { MemoryStore } from "./memory/memoryStore";
import { ToolError } from "./mocks/errors";
import { MockProviderService, type ForcedBookOutcome } from "./mocks/providerService";
import { Ledger } from "./store/ledger";
import { SessionStore, pushAssistantText, pushUserContent } from "./store/sessionStore";
import { Tracer } from "./trace/tracer";
import type { Approval, OutputMessage, Session, TranscriptEntry } from "./types";
import { addDays, localNow, nowIso, slotLabel } from "./util/time";

export interface AppDeps {
  llm: LLMClient;
  provider: MockProviderService;
  memory: MemoryStore;
  ledger: Ledger;
  sessions: SessionStore;
  gate: ApprovalGate;
  executor: ActionExecutor;
}

export interface RunHooks {
  onProgress?: (text: string) => void;
  /** Called as soon as each user-facing message is produced (for streaming UIs). */
  onOutput?: (msg: OutputMessage) => void;
}

export function createDeps(overrides: Partial<Pick<AppDeps, "llm">> = {}): AppDeps {
  const provider = new MockProviderService();
  const ledger = new Ledger();
  const gate = new ApprovalGate(ledger, provider);
  return {
    llm: overrides.llm ?? new AnthropicLLMClient(),
    provider,
    memory: new MemoryStore(),
    ledger,
    sessions: new SessionStore(),
    gate,
    executor: new ActionExecutor(ledger, provider, gate),
  };
}

const APP_NOTE = "[APPLICATION NOTE — not typed by the user]";
const APP_EVENT = "[APPLICATION EVENT — not typed by the user]";

export class ErrandApp {
  session: Session;
  tracer: Tracer;
  /** Agent model override for this app instance; defaults to config.agentModel. */
  model?: string;
  private hooks: RunHooks = {};

  constructor(
    readonly deps: AppDeps,
    opts: { resume?: boolean; userId?: string; sessionId?: string } = {},
  ) {
    const userId = opts.userId ?? config.userId;
    const existing = opts.sessionId
      ? deps.sessions.get(opts.sessionId)
      : opts.resume
        ? deps.sessions.loadLatest(userId)
        : undefined;
    this.session = existing ?? deps.sessions.create(userId);
    this.tracer = new Tracer(this.session.file_name, this.session.id);
  }

  /** Serializable view of the workflow for UIs. */
  snapshot() {
    const s = this.session;
    const pending = this.deps.ledger.getApproval(s.state.pending_approval_id);
    return {
      session_id: s.id,
      intent_verified: s.intent_verified,
      phase: s.state.phase,
      intent: s.state.intent ?? null,
      request: s.state.request,
      active_hold: s.state.active_hold ?? null,
      pending_approval: pending?.status === "pending" ? pending : null,
      session_file: this.sessionFile,
      trace_file: this.tracer.file,
    };
  }

  get sessionFile() {
    return this.deps.sessions.filePath(this.session);
  }

  newSession() {
    this.session = this.deps.sessions.create(this.session.user_id);
    this.tracer = new Tracer(this.session.file_name, this.session.id);
  }

  private log(role: TranscriptEntry["role"], text: string) {
    this.session.transcript.push({ at: nowIso(), role, text });
  }

  private emit(out: OutputMessage[], msg: OutputMessage) {
    out.push(msg);
    this.hooks.onOutput?.(msg);
    const role = msg.kind === "confirmation" ? "confirmation" : msg.kind === "assistant" ? "assistant" : "system";
    if (msg.kind !== "progress") this.log(role, msg.text);
  }

  private save() {
    this.deps.sessions.save(this.session);
  }

  /** Resolve actions left in-flight by a crash/restart, and re-show any pending confirmation. */
  async startup(hooks: RunHooks = {}): Promise<OutputMessage[]> {
    this.hooks = hooks;
    const out: OutputMessage[] = [];
    const inflight = this.deps.ledger.inFlightActions(this.session.user_id);
    if (inflight.length) {
      this.tracer.startRun("restart_recovery", `${inflight.length} in-flight action(s)`);
      for (const action of inflight) {
        const outcome = await this.deps.executor.resolveInFlight(action, this.tracer);
        this.emit(out, { kind: "system", text: outcome.message });
        pushAssistantText(this.session.messages, outcome.message);
      }
      this.tracer.endRun("recovered", { actions: inflight.map((a) => a.id) });
    }
    const pending = this.deps.ledger.getApproval(this.session.state.pending_approval_id);
    if (pending?.status === "pending") this.emit(out, { kind: "confirmation", text: renderApprovalPrompt(pending), approval: pending });
    this.save();
    return out;
  }

  async handleUserMessage(text: string, hooks: RunHooks = {}): Promise<OutputMessage[]> {
    this.hooks = hooks;
    const out: OutputMessage[] = [];
    const s = this.session;
    this.tracer.startRun("user_message", text);
    this.log("user", text);
    let outcome = "completed";

    try {
      const pending = this.deps.ledger.getApproval(s.state.pending_approval_id);
      if (pending && pending.status === "pending") {
        const decision = classifyConfirmation(text);
        this.tracer.event("confirmation_reply", { approval_id: pending.id, decision });
        s.state.pending_approval_id = undefined;

        if (decision === "yes") {
          this.deps.ledger.setApprovalStatus(pending.id, "approved", "user replied yes");
          this.tracer.event("approval_granted", { approval_id: pending.id, action: pending.action, details: pending.details });
          pushUserContent(s.messages, text);
          await this.executeApproval(pending, out, hooks);
          outcome = "executed_approval";
          return out;
        }
        if (decision === "no") {
          this.deps.ledger.setApprovalStatus(pending.id, "rejected", "user replied no");
          setPhase(s, this.tracer, "collecting", "approval_rejected");
          s.state.active_hold = undefined;
          pushUserContent(s.messages, [
            { type: "text", text },
            { type: "text", text: `${APP_NOTE} The user declined the ${pending.action} confirmation. Nothing was executed.` },
          ]);
          const reply = "Okay, I won't go ahead — nothing was booked or changed. Would you like a different slot, provider or budget?";
          pushAssistantText(s.messages, reply);
          this.emit(out, { kind: "assistant", text: reply });
          s.state.last_output_kind = "agent";
          outcome = "approval_rejected";
          return out;
        }
        this.deps.ledger.setApprovalStatus(pending.id, "superseded", "user replied with something other than yes/no");
        this.tracer.event("approval_superseded", { approval_id: pending.id });
        setPhase(s, this.tracer, "collecting", "approval_superseded");
        pushUserContent(s.messages, [
          {
            type: "text",
            text: `${APP_NOTE} The pending ${pending.action} confirmation was cancelled because the user replied with something other than yes/no. Nothing was executed. Apply what the user says below; any ${pending.action} needs a fresh request_approval.`,
          },
          { type: "text", text },
        ]);
        await this.runAgentAndRender(out, hooks);
        return out;
      }

      if (classifyConfirmation(text) === "yes" && s.state.last_output_kind === "execution_result") {
        const last = this.deps.ledger.getAction(s.state.last_executed_action_id);
        if (last?.status === "succeeded") {
          this.tracer.event("duplicate_confirmation_ignored", { action_id: last.id });
          this.emit(out, { kind: "assistant", text: `That's already done (${last.outcome}). I haven't repeated it.` });
          outcome = "duplicate_confirmation_ignored";
          return out;
        }
      }

      if (!s.intent_verified) {
        const intent = await classifyIntent(this.deps.llm, text, this.tracer);
        if (!intent.relevant) {
          this.emit(out, { kind: "assistant", text: intent.reply! });
          outcome = `intent_rejected:${intent.intent}`;
          return out;
        }
        s.intent_verified = true;
        s.state.intent = intent.intent;
      }

      pushUserContent(s.messages, text);
      if (s.state.phase === "idle" || s.state.phase === "done" || s.state.phase === "failed") {
        setPhase(s, this.tracer, "collecting", "new_user_request");
      }
      await this.runAgentAndRender(out, hooks);
      return out;
    } catch (err) {
      outcome = "unexpected_error";
      this.tracer.event("unexpected_error", { error: (err as Error).stack ?? String(err) });
      this.emit(out, { kind: "error", text: `Something went wrong on my side (${(err as Error).message}). Nothing was booked or changed.` });
      return out;
    } finally {
      this.save();
      this.tracer.endRun(outcome, { phase: s.state.phase });
    }
  }

  private async runAgentAndRender(out: OutputMessage[], hooks: RunHooks) {
    const s = this.session;
    const res = await runAgent(
      s,
      {
        ...this.deps,
        model: this.model,
        onToolCall: (name, input) => hooks.onProgress?.(`${name} ${JSON.stringify(input)}`),
      },
      this.tracer,
    );
    for (const t of res.texts) this.emit(out, { kind: "assistant", text: t });
    if (res.approval) this.showApproval(res.approval, out);
    else s.state.last_output_kind = "agent";
  }

  private showApproval(approval: Approval, out: OutputMessage[]) {
    this.session.state.pending_approval_id = approval.id;
    setPhase(this.session, this.tracer, "awaiting_approval", `approval_requested:${approval.action}`);
    this.tracer.event("approval_requested", { approval_id: approval.id, action: approval.action, details: approval.details });
    this.emit(out, { kind: "confirmation", text: renderApprovalPrompt(approval), approval });
    this.session.state.last_output_kind = "confirmation";
  }

  private async executeApproval(approval: Approval, out: OutputMessage[], hooks: RunHooks) {
    const s = this.session;
    setPhase(s, this.tracer, "executing", `approved:${approval.action}`);
    hooks.onProgress?.(`executing ${approval.action} (approval ${approval.id})…`);
    const outcome = await this.deps.executor.execute(approval, s, this.tracer);
    this.tracer.event("execution_outcome", { kind: outcome.kind, message: outcome.message });

    switch (outcome.kind) {
      case "succeeded":
      case "already_done":
        setPhase(s, this.tracer, "done", `execution_${outcome.kind}`);
        s.state.active_hold = undefined;
        s.state.last_executed_action_id = outcome.action_id;
        s.state.last_output_kind = "execution_result";
        pushAssistantText(s.messages, outcome.message);
        this.emit(out, { kind: "assistant", text: outcome.message });
        return;
      case "failed":
        setPhase(s, this.tracer, "failed", "execution_failed");
        s.state.active_hold = undefined;
        if (outcome.action_id) s.state.last_executed_action_id = outcome.action_id;
        s.state.last_output_kind = "execution_result";
        pushAssistantText(s.messages, outcome.message);
        this.emit(out, { kind: "assistant", text: outcome.message });
        return;
      case "needs_new_approval":
        pushAssistantText(s.messages, outcome.message);
        this.emit(out, { kind: "system", text: outcome.message });
        this.showApproval(outcome.approval, out);
        return;
      case "handoff":
        s.state.active_hold = undefined;
        setPhase(s, this.tracer, "collecting", "execution_handoff");
        pushAssistantText(s.messages, outcome.message);
        this.emit(out, { kind: "system", text: outcome.message });
        pushUserContent(s.messages, `${APP_NOTE} ${outcome.agent_note}`);
        await this.runAgentAndRender(out, hooks);
        return;
    }
  }

  /** Detect provider-side events without a user prompt and act on them. */
  async pollEvents(hooks: RunHooks = {}): Promise<OutputMessage[]> {
    this.hooks = hooks;
    const out: OutputMessage[] = [];
    const events = this.deps.provider.drainEvents(this.session.user_id);
    for (const ev of events) {
      this.tracer.startRun("provider_event", `${ev.type} ${ev.booking_id}`);
      let outcome = "handled";
      try {
        const booking = this.deps.provider.getBooking(ev.booking_id);
        const upcoming = !!booking && booking.slot > localNow().stamp;
        this.tracer.event("proactive_decision", {
          event_id: ev.id,
          booking_id: ev.booking_id,
          decision: upcoming ? "notify_and_find_replacement" : "ignore_past_booking",
        });
        if (!booking || !upcoming) {
          outcome = "ignored";
          continue;
        }

        const s = this.session;
        for (const a of this.deps.ledger.pendingApprovalsForSession(s.id)) {
          this.deps.ledger.setApprovalStatus(a.id, "superseded", "provider cancellation event");
        }
        s.state.pending_approval_id = undefined;
        s.state.active_hold = undefined;
        s.intent_verified = true;
        s.state.intent = "book_service";
        const date = booking.slot.slice(0, 10);
        const today = localNow().date;
        const dayBefore = addDays(date, -1);
        s.state.request = {
          ...s.state.request,
          service: booking.service,
          date_from: dayBefore < today ? today : dayBefore,
          date_to: addDays(date, 2),
          target_booking_id: booking.booking_id,
          notes: [`replacement for ${booking.booking_id} cancelled by ${booking.provider_name}`],
        };
        setPhase(s, this.tracer, "collecting", "provider_cancelled_booking");

        const notice = `⚠ Heads-up: ${booking.provider_name} cancelled your ${booking.service} booking ${booking.booking_id} (${slotLabel(booking.slot)}). I'm looking for a replacement that fits your preferences — I won't book anything without your confirmation.`;
        this.emit(out, { kind: "system", text: notice });
        hooks.onProgress?.("finding a replacement…");
        pushUserContent(
          s.messages,
          `${APP_EVENT} ${booking.provider_name} (${booking.provider_id}) cancelled booking ${booking.booking_id} for ${booking.service} at ${booking.slot} (₹${booking.price}). ` +
            `The user has already been notified. Find a replacement near the original time that respects the user's known preferences (area, time window, budget, preferred providers). ` +
            `Prefer other providers over ${booking.provider_id}. Don't ask for details already known. Present the best option briefly, hold it and call request_approval.`,
        );
        await this.runAgentAndRender(out, hooks);
      } catch (err) {
        outcome = "error";
        this.tracer.event("unexpected_error", { error: (err as Error).message });
        this.emit(out, { kind: "error", text: `A provider cancelled booking ${ev.booking_id}, but I hit an error finding a replacement (${(err as Error).message}). Please ask me to find a new slot.` });
      } finally {
        this.save();
        this.tracer.endRun(outcome);
      }
    }
    return out;
  }

  // ───────────── User-facing utilities (CLI commands) ─────────────

  listMemories(includeForgotten = false) {
    return this.deps.memory.all(this.session.user_id, { includeForgotten });
  }

  forgetMemory(idOrKey: string) {
    const removed = this.deps.memory.forget(this.session.user_id, idOrKey);
    this.tracer.event("memory_forgotten", { by: "user_command", keys: removed.map((m) => `${m.scope}.${m.key}`) });
    return removed;
  }

  confirmMemory(id: string) {
    const m = this.deps.memory.confirm(this.session.user_id, id);
    if (m) this.tracer.event("memory_confirmed", { id, key: m.key });
    return m;
  }

  editMemory(id: string, value: string) {
    const m = this.deps.memory.edit(this.session.user_id, id, value);
    if (m) this.tracer.event("memory_corrected", { id, key: m.key });
    return m;
  }

  async listBookings() {
    return (await this.deps.provider.list_bookings({ user_id: this.session.user_id })).bookings;
  }

  forceNextBookOutcome(outcome: ForcedBookOutcome) {
    this.deps.provider.forceNextBookOutcome(outcome);
    this.tracer.event("simulation_control", { control: "force_book_outcome", outcome });
  }

  setPriceChange(providerId: string, pct: number) {
    this.deps.provider.setPriceChangeOnHold(providerId, pct);
    this.tracer.event("simulation_control", { control: "price_change_on_hold", provider_id: providerId, pct });
  }

  simulateProviderCancel(bookingId: string) {
    try {
      const ev = this.deps.provider.simulateProviderCancel(bookingId);
      this.tracer.event("simulation_control", { control: "provider_cancel", booking_id: bookingId, event_id: ev.id });
      return ev;
    } catch (err) {
      if (err instanceof ToolError) throw new Error(err.message);
      throw err;
    }
  }
}
