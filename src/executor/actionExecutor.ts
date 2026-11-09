import type { ApprovalGate } from "../approval/approvalGate";
import { config } from "../config";
import { asToolError, ToolError } from "../mocks/errors";
import { makeSlotId, type MockProviderService } from "../mocks/providerService";
import type { Ledger } from "../store/ledger";
import type { Tracer } from "../trace/tracer";
import type { ActionRecord, Approval, Session } from "../types";
import { sleep, slotLabel } from "../util/time";

export type ExecutionOutcome =
  | { kind: "succeeded"; message: string; action_id: string; booking_id?: string }
  | { kind: "already_done"; message: string; action_id: string }
  | { kind: "needs_new_approval"; message: string; approval: Approval }
  | { kind: "handoff"; message: string; agent_note: string; action_id?: string }
  | { kind: "failed"; message: string; action_id?: string };

const backoff = (attempt: number) => config.execution.retryBaseDelayMs * 2 ** (attempt - 1);

/**
 * Runs approved side effects. Lives entirely in application code: the model never calls
 * book/cancel/reschedule and never sees or chooses idempotency keys.
 */
export class ActionExecutor {
  constructor(
    private readonly ledger: Ledger,
    private readonly provider: MockProviderService,
    private readonly gate: ApprovalGate,
  ) {}

  private async call<T>(tracer: Tracer, tool: string, args: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const result = await fn();
      tracer.recordToolCall({ tool, args, latency_ms: Date.now() - started, ok: true, result, executed_by: "application" });
      return result;
    } catch (err) {
      const te = asToolError(err);
      tracer.recordToolCall({ tool, args, latency_ms: Date.now() - started, ok: false, result: te.toJSON(), executed_by: "application" });
      throw te;
    }
  }

  async execute(approval: Approval, session: Session, tracer: Tracer): Promise<ExecutionOutcome> {
    const existing = this.ledger.actionForApproval(approval.id);
    if (existing?.status === "succeeded") {
      return { kind: "already_done", action_id: existing.id, message: `Already done — ${existing.outcome ?? existing.booking_id ?? "no further action needed"}. I did not repeat it.` };
    }
    if (existing?.status === "executing") return this.resolveInFlight(existing, tracer);
    if (existing?.status === "failed") {
      return { kind: "failed", action_id: existing.id, message: "That confirmation was already used for an attempt that failed. Ask me to try again for a fresh confirmation." };
    }

    let check = this.gate.verify(approval);
    tracer.event("approval_gate_check", { approval_id: approval.id, action: approval.action, result: check });

    if (!check.ok && check.reason === "hold_expired" && approval.action === "book") {
      const rehold = await this.rehold(approval, session, tracer);
      if (rehold) return rehold;
      check = this.gate.verify(approval);
      tracer.event("approval_gate_check", { approval_id: approval.id, action: approval.action, result: check, after: "rehold" });
    }
    if (!check.ok) {
      this.ledger.setApprovalStatus(approval.id, "invalidated", check.reason);
      return {
        kind: "handoff",
        message: `Nothing was done: ${check.message}`,
        agent_note: `The approved ${approval.action} was blocked by the approval gate (${check.reason}: ${check.message}). Nothing was executed. Help the user decide the next step; any new action needs a fresh request_approval.`,
      };
    }

    this.ledger.setApprovalStatus(approval.id, "consumed");
    if (approval.action === "book") return this.book(approval, session, tracer);
    if (approval.action === "cancel") return this.cancel(approval, session, tracer);
    return this.reschedule(approval, session, tracer);
  }

  /** Hold expired before the user confirmed: re-hold the same slot; any price change needs fresh approval. */
  private async rehold(approval: Approval, session: Session, tracer: Tracer): Promise<ExecutionOutcome | null> {
    const d = approval.details;
    try {
      const h = await this.call(tracer, "hold_slot", { provider_id: d.provider_id, slot: makeSlotId(d.service, d.slot!) }, () =>
        this.provider.hold_slot({ provider_id: d.provider_id, slot: makeSlotId(d.service, d.slot!) }),
      );
      if (h.quoted_price === d.price && h.slot === d.slot && h.provider_id === d.provider_id) {
        this.ledger.updateApprovalDetails(approval.id, { hold_id: h.hold_id, hold_expires_at: h.expires_at });
        tracer.event("rehold_no_material_change", { approval_id: approval.id, new_hold_id: h.hold_id });
        return null;
      }
      this.ledger.setApprovalStatus(approval.id, "invalidated", "price changed on re-hold");
      const fresh = this.gate.createApproval(session, { action: "book", hold_id: h.hold_id });
      tracer.event("approval_invalidated", { approval_id: approval.id, reason: "material_change_on_rehold", new_approval_id: fresh.id });
      return {
        kind: "needs_new_approval",
        approval: fresh,
        message: `The 10-minute hold expired. I re-held the same slot but the price is now ₹${h.quoted_price} (you approved ₹${d.price}), so I need your confirmation again.`,
      };
    } catch (err) {
      const te = asToolError(err);
      this.ledger.setApprovalStatus(approval.id, "invalidated", `rehold failed: ${te.code}`);
      return {
        kind: "handoff",
        message: `The hold expired and ${slotLabel(d.slot!)} is no longer available. Nothing was booked.`,
        agent_note: `Hold expired and re-holding ${d.provider_name} at ${d.slot} failed (${te.code}). Nothing was booked. Offer alternative slots/providers that fit the user's constraints, then hold and request_approval again.`,
      };
    }
  }

  private async bookingStatus(tracer: Tracer, key: string) {
    for (let i = 1; i <= 2; i++) {
      try {
        return await this.call(tracer, "get_booking_status", { idempotency_key: key }, () => this.provider.get_booking_status({ idempotency_key: key }));
      } catch {
        await sleep(backoff(i));
      }
    }
    return undefined;
  }

  private bookSucceeded(action: ActionRecord, booking: { booking_id: string; provider_name: string; service: string; slot: string; price: number }, how: string, tracer: Tracer): ExecutionOutcome {
    const summary = `${booking.booking_id} — ${booking.provider_name}, ${booking.service}, ${slotLabel(booking.slot)}, ₹${booking.price}`;
    this.ledger.updateAction(action.id, { status: "succeeded", booking_id: booking.booking_id, outcome: summary });
    tracer.event("action_succeeded", { action_id: action.id, action_type: "book", verified_via: how, booking_id: booking.booking_id });
    return { kind: "succeeded", action_id: action.id, booking_id: booking.booking_id, message: `✅ Booked and verified: ${summary}.` };
  }

  private async book(approval: Approval, session: Session, tracer: Tracer): Promise<ExecutionOutcome> {
    const d = approval.details;
    const key = `book_${approval.id}`;
    const action = this.ledger.startAction({ approval_id: approval.id, session_id: session.id, user_id: session.user_id, type: "book", idempotency_key: key });
    tracer.event("action_started", { action_id: action.id, action_type: "book", idempotency_key: key, hold_id: d.hold_id });

    for (let attempt = 1; attempt <= config.execution.maxBookAttempts; attempt++) {
      this.ledger.updateAction(action.id, { attempts: attempt });
      try {
        const res = await this.call(tracer, "book", { hold_id: d.hold_id, idempotency_key: key }, () =>
          this.provider.book({ hold_id: d.hold_id!, idempotency_key: key }),
        );
        const status = await this.bookingStatus(tracer, key);
        if (status && status.status !== "confirmed") {
          tracer.event("verification_mismatch", { action_id: action.id, book_result: res.status, status: status.status });
        }
        return this.bookSucceeded(action, res, "book_response+get_booking_status", tracer);
      } catch (err) {
        const te = asToolError(err);
        if (te.code === "timeout") {
          tracer.event("booking_outcome_ambiguous", { action_id: action.id, attempt, note: "timeout; querying source of truth before any retry" });
          const status = await this.bookingStatus(tracer, key);
          if (status?.status === "confirmed" && "booking" in status && status.booking) {
            tracer.event("timeout_after_success_detected", { action_id: action.id, booking_id: status.booking.booking_id });
            return this.bookSucceeded(action, status.booking, "get_booking_status_after_timeout", tracer);
          }
          tracer.event("timeout_not_booked", { action_id: action.id, attempt, status: status?.status ?? "unknown" });
          if (attempt < config.execution.maxBookAttempts) await sleep(backoff(attempt));
          continue;
        }
        if (te.code === "slot_taken" || te.code === "hold_expired" || te.code === "hold_already_used") {
          this.ledger.updateAction(action.id, { status: "failed", error: te.code });
          return {
            kind: "handoff",
            action_id: action.id,
            message: te.code === "slot_taken" ? `${slotLabel(d.slot!)} with ${d.provider_name} was just taken by someone else. Nothing was booked.` : `The hold on ${slotLabel(d.slot!)} is no longer valid. Nothing was booked.`,
            agent_note: `Booking failed with ${te.code} for ${d.provider_name} (${d.provider_id}) at ${d.slot}. Nothing was booked. Do not retry that slot. Offer the best alternatives within the user's constraints (other slots of the same provider first, then other providers); hold and request_approval again.`,
          };
        }
        if (te.retryable && attempt < config.execution.maxBookAttempts) {
          await sleep(backoff(attempt));
          continue;
        }
        this.ledger.updateAction(action.id, { status: "failed", error: `${te.code}: ${te.message}` });
        return { kind: "failed", action_id: action.id, message: `I couldn't complete the booking (${te.code}). Nothing was booked.` };
      }
    }

    // Retries exhausted: ask the source of truth one last time before reporting.
    const final = await this.bookingStatus(tracer, key);
    if (final?.status === "confirmed" && "booking" in final && final.booking) {
      return this.bookSucceeded(action, final.booking, "final_status_check", tracer);
    }
    this.ledger.updateAction(action.id, { status: "failed", error: "retries_exhausted" });
    tracer.event("action_failed", { action_id: action.id, reason: "retries_exhausted", final_status: final?.status ?? "unknown" });
    return {
      kind: "failed",
      action_id: action.id,
      message: `The provider kept timing out after ${config.execution.maxBookAttempts} attempts. I checked their records: nothing was booked and nothing was charged. You can ask me to try again.`,
    };
  }

  private async findBooking(tracer: Tracer, userId: string, bookingId: string) {
    const res = await this.call(tracer, "list_bookings", { user_id: userId }, () => this.provider.list_bookings({ user_id: userId }));
    return res.bookings.find((b) => b.booking_id === bookingId);
  }

  private async cancel(approval: Approval, session: Session, tracer: Tracer): Promise<ExecutionOutcome> {
    const d = approval.details;
    const key = `cancel_${approval.id}`;
    const action = this.ledger.startAction({ approval_id: approval.id, session_id: session.id, user_id: session.user_id, type: "cancel", idempotency_key: key });
    tracer.event("action_started", { action_id: action.id, action_type: "cancel", idempotency_key: key, booking_id: d.booking_id });

    let lastError: ToolError | undefined;
    for (let attempt = 1; attempt <= config.execution.maxCancelAttempts; attempt++) {
      this.ledger.updateAction(action.id, { attempts: attempt });
      try {
        await this.call(tracer, "cancel", { booking_id: d.booking_id, idempotency_key: key }, () =>
          this.provider.cancel({ booking_id: d.booking_id!, idempotency_key: key }),
        );
        const b = await this.findBooking(tracer, session.user_id, d.booking_id!);
        if (b?.status === "cancelled") {
          const summary = `${d.booking_id} — ${d.provider_name}, ${slotLabel(d.slot!)}`;
          this.ledger.updateAction(action.id, { status: "succeeded", booking_id: d.booking_id, outcome: `cancelled ${summary}` });
          return { kind: "succeeded", action_id: action.id, booking_id: d.booking_id, message: `✅ Cancelled and verified: ${summary}.` };
        }
        lastError = new ToolError("internal_error", `cancel returned OK but booking shows ${b?.status ?? "missing"}`);
      } catch (err) {
        lastError = asToolError(err);
        if (!lastError.retryable) break;
      }
      if (attempt < config.execution.maxCancelAttempts) await sleep(backoff(attempt));
    }
    this.ledger.updateAction(action.id, { status: "failed", error: lastError ? `${lastError.code}: ${lastError.message}` : "unknown" });
    return {
      kind: "failed",
      action_id: action.id,
      message: `I couldn't cancel ${d.booking_id} (${lastError?.code ?? "unknown error"}). The booking is still active — please try again shortly.`,
    };
  }

  private async reschedule(approval: Approval, session: Session, tracer: Tracer): Promise<ExecutionOutcome> {
    const d = approval.details;
    const key = `resched_${approval.id}`;
    const action = this.ledger.startAction({ approval_id: approval.id, session_id: session.id, user_id: session.user_id, type: "reschedule", idempotency_key: key });
    tracer.event("action_started", { action_id: action.id, action_type: "reschedule", idempotency_key: key, booking_id: d.booking_id, new_slot: d.new_slot });

    let lastError: ToolError | undefined;
    for (let attempt = 1; attempt <= config.execution.maxRescheduleAttempts; attempt++) {
      this.ledger.updateAction(action.id, { attempts: attempt });
      try {
        await this.call(tracer, "reschedule", { booking_id: d.booking_id, slot: d.new_slot, idempotency_key: key }, () =>
          this.provider.reschedule({ booking_id: d.booking_id!, slot: d.new_slot!, idempotency_key: key }),
        );
        const b = await this.findBooking(tracer, session.user_id, d.booking_id!);
        if (b && b.slot === d.new_slot && b.status === "confirmed") {
          const summary = `${d.booking_id} — ${d.provider_name} moved to ${slotLabel(d.new_slot!)}`;
          this.ledger.updateAction(action.id, { status: "succeeded", booking_id: d.booking_id, outcome: summary });
          return { kind: "succeeded", action_id: action.id, booking_id: d.booking_id, message: `✅ Rescheduled and verified: ${summary}.` };
        }
        lastError = new ToolError("internal_error", "reschedule returned OK but booking was not updated");
      } catch (err) {
        lastError = asToolError(err);
        if (lastError.code === "slot_conflict") {
          this.ledger.updateAction(action.id, { status: "failed", error: "slot_conflict" });
          return {
            kind: "handoff",
            action_id: action.id,
            message: `${slotLabel(d.new_slot!)} conflicts with ${d.provider_name}'s schedule. Your booking is unchanged (${slotLabel(d.old_slot!)}).`,
            agent_note: `Reschedule of ${d.booking_id} to ${d.new_slot} failed with slot_conflict; booking unchanged at ${d.old_slot}. Offer other slots from the same provider that fit the user's constraints, then request_approval again.`,
          };
        }
        if (!lastError.retryable) break;
      }
      if (attempt < config.execution.maxRescheduleAttempts) await sleep(backoff(attempt));
    }
    this.ledger.updateAction(action.id, { status: "failed", error: lastError ? `${lastError.code}: ${lastError.message}` : "unknown" });
    return { kind: "failed", action_id: action.id, message: `I couldn't reschedule ${d.booking_id} (${lastError?.code ?? "unknown error"}). It is still at ${slotLabel(d.old_slot!)}.` };
  }

  /** Resolve an action left "executing" (e.g. the process died mid-call) using the provider's records. */
  async resolveInFlight(action: ActionRecord, tracer: Tracer): Promise<ExecutionOutcome> {
    tracer.event("recovery_check", { action_id: action.id, action_type: action.type, idempotency_key: action.idempotency_key });
    const approval = this.ledger.getApproval(action.approval_id);
    if (action.type === "book") {
      const status = await this.bookingStatus(tracer, action.idempotency_key);
      if (status?.status === "confirmed" && "booking" in status && status.booking) {
        const out = this.bookSucceeded(action, status.booking, "restart_recovery", tracer);
        return { ...out, message: `Recovered an interrupted booking: ${out.message}` };
      }
      this.ledger.updateAction(action.id, { status: "failed", error: `interrupted; provider status ${status?.status ?? "unknown"}` });
      return { kind: "failed", action_id: action.id, message: "A booking was interrupted before it completed. I checked with the provider: nothing was booked." };
    }
    const d = approval?.details;
    const b = d?.booking_id ? this.provider.getBooking(d.booking_id) : undefined;
    const done = action.type === "cancel" ? b?.status === "cancelled" : !!b && b.slot === d?.new_slot;
    this.ledger.updateAction(action.id, done ? { status: "succeeded", outcome: `${action.type} ${d?.booking_id} (recovered)` } : { status: "failed", error: "interrupted" });
    return done
      ? { kind: "succeeded", action_id: action.id, message: `Recovered an interrupted ${action.type}: ${d?.booking_id} is ${action.type === "cancel" ? "cancelled" : `now at ${slotLabel(d!.new_slot!)}`} (verified).` }
      : { kind: "failed", action_id: action.id, message: `An interrupted ${action.type} of ${d?.booking_id} did not complete; the booking is unchanged.` };
  }
}
