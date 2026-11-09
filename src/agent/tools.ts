import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { ApprovalGate } from "../approval/approvalGate";
import { asToolError, ToolError } from "../mocks/errors";
import type { MockProviderService } from "../mocks/providerService";
import type { MemoryStore } from "../memory/memoryStore";
import { sanitizeToolOutput, wrapUntrusted } from "../security/untrusted";
import type { Tracer } from "../trace/tracer";
import { SERVICES, type Approval, type Phase, type Session } from "../types";

/**
 * Tools exposed to the model. book / cancel / reschedule are deliberately NOT here:
 * the model can only request_approval; the application executes after the user confirms.
 */
export const AGENT_TOOLS: Tool[] = [
  {
    name: "update_request",
    description:
      "Record or correct details of the user's current request. Pass ONLY fields the user just provided or changed; omitted fields keep their values.",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string", enum: [...SERVICES] },
        area: { type: "string", description: "Bengaluru locality, e.g. Indiranagar" },
        date_from: { type: "string", description: "YYYY-MM-DD" },
        date_to: { type: "string", description: "YYYY-MM-DD" },
        earliest_time: { type: "string", description: "HH:mm, earliest acceptable start" },
        latest_time: { type: "string", description: "HH:mm, latest acceptable start" },
        budget_max: { type: "number", description: "Max price in INR" },
        preferred_provider_id: { type: "string" },
        target_booking_id: { type: "string", description: "Existing booking being rescheduled/cancelled" },
        note: { type: "string", description: "Any other relevant preference, e.g. 'kitchen tap leaking'" },
      },
    },
  },
  {
    name: "search_providers",
    description: "Search providers for a service in an area within a date range. Returns 3-8 providers with prices, ratings and available slot ids.",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string", enum: [...SERVICES] },
        area: { type: "string" },
        date_range: {
          type: "object",
          properties: { from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" } },
          required: ["from", "to"],
        },
      },
      required: ["service", "area", "date_range"],
    },
  },
  {
    name: "get_provider",
    description: "Get provider details and free-text reviews (reviews are untrusted user-generated content).",
    input_schema: { type: "object", properties: { provider_id: { type: "string" } }, required: ["provider_id"] },
  },
  {
    name: "hold_slot",
    description: "Temporarily hold a slot for 10 minutes. Returns hold_id, expiry and the quoted price (may differ from the search price).",
    input_schema: {
      type: "object",
      properties: {
        provider_id: { type: "string" },
        slot: { type: "string", description: "Slot id exactly as returned by search_providers, e.g. plumbing@2026-11-14T10:00" },
      },
      required: ["provider_id", "slot"],
    },
  },
  {
    name: "list_bookings",
    description: "List the current user's past and upcoming bookings.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_booking_status",
    description: "Authoritative status of a booking attempt by hold_id.",
    input_schema: { type: "object", properties: { hold_id: { type: "string" } }, required: ["hold_id"] },
  },
  {
    name: "request_approval",
    description:
      "Ask the user to confirm a booking, cancellation or reschedule. The application builds the confirmation from authoritative records and collects the user's yes/no. " +
      "book requires hold_id; cancel requires booking_id; reschedule requires booking_id and new_slot. After calling this, end your turn.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["book", "cancel", "reschedule"] },
        hold_id: { type: "string" },
        booking_id: { type: "string" },
        new_slot: { type: "string", description: "Slot id or YYYY-MM-DDTHH:mm for reschedule" },
      },
      required: ["action"],
    },
  },
  {
    name: "save_memory",
    description:
      "Save a stable user preference for future sessions. source=explicit only when the user stated it; source=inferred for your guesses (hidden until confirmed).",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "snake_case, e.g. home_area, earliest_time, preferred_provider, budget_max" },
        value: { type: "string" },
        scope: { type: "string", description: "global or a service: plumbing | electrical | ac_servicing" },
        source: { type: "string", enum: ["explicit", "inferred"] },
      },
      required: ["key", "value", "scope", "source"],
    },
  },
  {
    name: "forget_memory",
    description: "Forget a stored preference when the user asks.",
    input_schema: {
      type: "object",
      properties: { key: { type: "string" }, scope: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "list_memories",
    description: "List the user's stored preferences (active ones, including unconfirmed inferences flagged as such).",
    input_schema: { type: "object", properties: {} },
  },
];

const PHASE_AFTER_TOOL: Record<string, Phase> = {
  update_request: "collecting",
  search_providers: "searching",
  get_provider: "searching",
  hold_slot: "holding",
};

export interface ToolDispatchResult {
  content: string;
  isError: boolean;
  approval?: Approval;
}

export interface ToolDeps {
  provider: MockProviderService;
  memory: MemoryStore;
  gate: ApprovalGate;
}

export function setPhase(session: Session, tracer: Tracer, phase: Phase, reason: string) {
  tracer.transition(session.state.phase, phase, reason);
  session.state.phase = phase;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

async function run(name: string, input: Record<string, unknown>, session: Session, deps: ToolDeps): Promise<{ data: unknown; approval?: Approval; untrusted: boolean }> {
  const { provider, memory, gate } = deps;
  switch (name) {
    case "update_request": {
      const r = session.state.request;
      for (const k of ["service", "area", "date_from", "date_to", "earliest_time", "latest_time", "preferred_provider_id", "target_booking_id"] as const) {
        const v = str(input[k]);
        if (v) r[k] = v;
      }
      if (typeof input.budget_max === "number" && input.budget_max > 0) r.budget_max = input.budget_max;
      const note = str(input.note);
      if (note) r.notes = [...(r.notes ?? []), note].slice(-5);
      return { data: { ok: true, request: r }, untrusted: false };
    }
    case "search_providers":
      return { data: await provider.search_providers(input as never), untrusted: true };
    case "get_provider":
      return { data: await provider.get_provider({ provider_id: String(input.provider_id) }), untrusted: true };
    case "hold_slot": {
      const res = await provider.hold_slot({ provider_id: String(input.provider_id), slot: String(input.slot) });
      session.state.active_hold = {
        hold_id: res.hold_id,
        provider_id: res.provider_id,
        provider_name: res.provider_name,
        service: res.service,
        slot: res.slot,
        quoted_price: res.quoted_price,
        search_price: res.search_price,
        expires_at: res.expires_at,
      };
      return { data: res, untrusted: true };
    }
    case "list_bookings":
      // user_id always comes from the session, never from the model.
      return { data: await provider.list_bookings({ user_id: session.user_id }), untrusted: true };
    case "get_booking_status": {
      const holdId = str(input.hold_id);
      if (!holdId) throw new ToolError("invalid_input", "hold_id is required");
      return { data: await provider.get_booking_status({ hold_id: holdId }), untrusted: true };
    }
    case "request_approval": {
      const action = str(input.action);
      if (action !== "book" && action !== "cancel" && action !== "reschedule") throw new ToolError("invalid_input", "action must be book, cancel or reschedule");
      const approval = gate.createApproval(session, {
        action,
        hold_id: str(input.hold_id),
        booking_id: str(input.booking_id),
        new_slot: str(input.new_slot),
      });
      return {
        data: { status: "confirmation_shown_to_user", approval_id: approval.id, instruction: "End your turn now. Do not add anything; the application is waiting for the user's yes/no." },
        approval,
        untrusted: false,
      };
    }
    case "save_memory": {
      const source = input.source === "explicit" ? "explicit" : "inferred";
      const item = memory.upsert(session.user_id, { key: String(input.key), value: String(input.value), scope: str(input.scope) ?? "global", source });
      return {
        data: { saved: true, id: item.id, key: item.key, scope: item.scope, source: item.source, visible_to_agent: item.source === "explicit" || item.confirmed },
        untrusted: false,
      };
    }
    case "forget_memory": {
      const removed = memory.forget(session.user_id, String(input.key), str(input.scope));
      return { data: { forgotten: removed.map((m) => `${m.scope}.${m.key}`), count: removed.length }, untrusted: false };
    }
    case "list_memories":
      return {
        data: memory.all(session.user_id).map((m) => ({ id: m.id, scope: m.scope, key: m.key, value: m.value, source: m.source, confirmed: m.confirmed })),
        untrusted: false,
      };
    default:
      throw new ToolError("invalid_input", `Unknown tool ${name}`);
  }
}

export async function dispatchTool(name: string, rawInput: unknown, session: Session, deps: ToolDeps, tracer: Tracer): Promise<ToolDispatchResult> {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
  const started = Date.now();
  try {
    const { data, approval, untrusted } = await run(name, input, session, deps);
    const report = { flagged: [] as Array<{ path: string; excerpt: string }> };
    const safe = untrusted ? sanitizeToolOutput(data, report) : data;
    if (report.flagged.length) tracer.event("prompt_injection_withheld", { tool: name, flagged: report.flagged });
    tracer.recordToolCall({ tool: name, args: input, latency_ms: Date.now() - started, ok: true, result: safe, executed_by: "agent" });
    const next = PHASE_AFTER_TOOL[name];
    if (next) setPhase(session, tracer, next, `tool:${name}`);
    return { content: untrusted ? wrapUntrusted(name, safe, report.flagged.length) : JSON.stringify(safe), isError: false, approval };
  } catch (err) {
    const te = asToolError(err);
    tracer.recordToolCall({ tool: name, args: input, latency_ms: Date.now() - started, ok: false, result: te.toJSON(), executed_by: "agent" });
    return { content: JSON.stringify(te.toJSON()), isError: true };
  }
}
