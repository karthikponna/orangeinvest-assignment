import { parseSlotId, type MockProviderService } from "../mocks/providerService";
import { ToolError } from "../mocks/errors";
import { findProvider } from "../mocks/data";
import type { Ledger } from "../store/ledger";
import type { Approval, ApprovalAction, Session } from "../types";
import { clockTime, isValidDateTime, slotLabel } from "../util/time";

export interface ApprovalRequestInput {
  action: ApprovalAction;
  hold_id?: string;
  booking_id?: string;
  new_slot?: string;
}

const YES = /^(y|yes|yeah|yep|yup|confirm|confirmed|ok|okay|sure|go ahead|book it|do it|proceed|yes please|yes,? (book|confirm|go ahead|proceed|cancel|reschedule)( it)?)[.! ]*$/i;
const NO = /^(n|no|nope|nah|stop|don'?t|do not|no thanks|not now|abort)[.! ]*$/i;

/** Approval is decided by deterministic matching of the user's reply — never by the model. */
export function classifyConfirmation(text: string): "yes" | "no" | "other" {
  const t = text.trim();
  if (YES.test(t)) return "yes";
  if (NO.test(t)) return "no";
  return "other";
}

/**
 * Enforces "no side effect without explicit approval of the exact details".
 * Approval details are always built from authoritative data (the provider's hold / booking
 * records), never from model-supplied arguments.
 */
export class ApprovalGate {
  constructor(
    private readonly ledger: Ledger,
    private readonly provider: MockProviderService,
  ) {}

  createApproval(session: Session, input: ApprovalRequestInput): Approval {
    // Only one pending approval per session; a new request supersedes older ones.
    for (const a of this.ledger.pendingApprovalsForSession(session.id)) {
      this.ledger.setApprovalStatus(a.id, "superseded", "a newer approval was requested");
    }

    if (input.action === "book") {
      if (!input.hold_id) throw new ToolError("invalid_input", "hold_id is required for a booking approval");
      const hold = this.provider.peekHold(input.hold_id);
      if (!hold) throw new ToolError("not_found", `Hold ${input.hold_id} not found`);
      if (!hold.active) throw new ToolError("hold_expired", `Hold ${input.hold_id} is no longer active; hold the slot again`);
      return this.ledger.createApproval({
        session_id: session.id,
        user_id: session.user_id,
        action: "book",
        details: {
          provider_id: hold.provider_id,
          provider_name: hold.provider_name,
          service: hold.service,
          hold_id: hold.hold_id,
          slot: hold.slot,
          price: hold.quoted_price,
          search_price: hold.search_price,
          hold_expires_at: hold.expires_at,
        },
      });
    }

    if (!input.booking_id) throw new ToolError("invalid_input", `booking_id is required for ${input.action}`);
    const booking = this.provider.getBooking(input.booking_id);
    if (!booking || booking.user_id !== session.user_id) {
      throw new ToolError("not_found", `Booking ${input.booking_id} not found for this user`);
    }
    if (booking.status !== "confirmed" || booking.when !== "upcoming") {
      throw new ToolError("invalid_state", `Booking ${booking.booking_id} is ${booking.status}/${booking.when} and cannot be changed`);
    }

    if (input.action === "cancel") {
      return this.ledger.createApproval({
        session_id: session.id,
        user_id: session.user_id,
        action: "cancel",
        details: {
          provider_id: booking.provider_id,
          provider_name: booking.provider_name,
          service: booking.service,
          booking_id: booking.booking_id,
          slot: booking.slot,
          price: booking.price,
        },
      });
    }

    const newSlot = parseSlotId(input.new_slot ?? "", booking.service).dateTime;
    if (!isValidDateTime(newSlot)) throw new ToolError("invalid_input", "new_slot is required for reschedule (YYYY-MM-DDTHH:mm)");
    if (newSlot === booking.slot) throw new ToolError("invalid_input", "new_slot is the same as the current slot");
    return this.ledger.createApproval({
      session_id: session.id,
      user_id: session.user_id,
      action: "reschedule",
      details: {
        provider_id: booking.provider_id,
        provider_name: booking.provider_name ?? findProvider(booking.provider_id)?.name ?? booking.provider_id,
        service: booking.service,
        booking_id: booking.booking_id,
        old_slot: booking.slot,
        new_slot: newSlot,
        price: booking.price,
      },
    });
  }

  /**
   * Final check immediately before execution. Any material difference between what the user
   * approved and the current authoritative record blocks the action.
   */
  verify(approval: Approval): { ok: true } | { ok: false; reason: "not_approved" | "already_used" | "hold_expired" | "details_changed" | "booking_changed"; message: string } {
    if (approval.status === "consumed") return { ok: false, reason: "already_used", message: "This approval was already used." };
    if (approval.status !== "approved") return { ok: false, reason: "not_approved", message: `Approval is ${approval.status}.` };

    const d = approval.details;
    if (approval.action === "book") {
      const hold = d.hold_id ? this.provider.peekHold(d.hold_id) : undefined;
      if (!hold) return { ok: false, reason: "details_changed", message: "The held slot no longer exists." };
      if (hold.provider_id !== d.provider_id || hold.slot !== d.slot || hold.quoted_price !== d.price) {
        return { ok: false, reason: "details_changed", message: "Provider, slot or price differs from what you approved." };
      }
      if (!hold.active) return { ok: false, reason: "hold_expired", message: "The 10-minute hold expired." };
      return { ok: true };
    }

    const booking = d.booking_id ? this.provider.getBooking(d.booking_id) : undefined;
    if (!booking || booking.status !== "confirmed") {
      return { ok: false, reason: "booking_changed", message: `Booking ${d.booking_id} is no longer active (${booking?.status ?? "missing"}).` };
    }
    const expectedSlot = approval.action === "cancel" ? d.slot : d.old_slot;
    if (booking.slot !== expectedSlot) {
      return { ok: false, reason: "booking_changed", message: "The booking changed since you approved this action." };
    }
    return { ok: true };
  }
}

export function renderApprovalPrompt(a: Approval): string {
  const d = a.details;
  const lines: string[] = [];
  if (a.action === "book") {
    lines.push("Please confirm this BOOKING:");
    lines.push(`  Provider : ${d.provider_name} (${d.provider_id})`);
    lines.push(`  Service  : ${d.service}`);
    lines.push(`  Slot     : ${slotLabel(d.slot!)}`);
    const changed = d.search_price !== undefined && d.search_price !== d.price;
    lines.push(`  Price    : ₹${d.price}${changed ? `  (⚠ listed at ₹${d.search_price}; provider quoted a different price when holding)` : ""}`);
    lines.push(`  Hold     : ${d.hold_id}, expires ${clockTime(d.hold_expires_at!)}`);
  } else if (a.action === "cancel") {
    lines.push("Please confirm this CANCELLATION:");
    lines.push(`  Booking  : ${d.booking_id} — ${d.provider_name} (${d.service})`);
    lines.push(`  Slot     : ${slotLabel(d.slot!)}`);
  } else {
    lines.push("Please confirm this RESCHEDULE:");
    lines.push(`  Booking  : ${d.booking_id} — ${d.provider_name} (${d.service})`);
    lines.push(`  From     : ${slotLabel(d.old_slot!)}`);
    lines.push(`  To       : ${slotLabel(d.new_slot!)}`);
  }
  lines.push(`Reply "yes" to confirm or "no" to decline. Any other message cancels this confirmation.`);
  return lines.join("\n");
}
