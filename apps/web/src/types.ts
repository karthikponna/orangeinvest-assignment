/** Mirrors src/types.ts in the core (Approval, OutputMessage, MemoryItem). */
export type ApprovalAction = "book" | "cancel" | "reschedule";

export type Approval = {
  id: string;
  action: ApprovalAction;
  status: string;
  details: {
    provider_id: string;
    provider_name: string;
    service: string;
    hold_id?: string;
    slot?: string;
    price?: number;
    search_price?: number;
    hold_expires_at?: string;
    booking_id?: string;
    old_slot?: string;
    new_slot?: string;
  };
};

export type OutputMessage = {
  kind: "assistant" | "confirmation" | "system" | "error" | "progress";
  text: string;
  approval?: Approval;
};

export type TraceEvent = {
  ts: string;
  seq: number;
  run_id: string | null;
  type: string;
  [key: string]: unknown;
};

export type SessionSnapshot = {
  session_id: string;
  intent_verified: boolean;
  phase: string;
  intent: string | null;
  request: Record<string, unknown>;
  active_hold: { hold_id: string; provider_name: string; slot: string; quoted_price: number; expires_at: string } | null;
  pending_approval: Approval | null;
  session_file: string;
  trace_file: string;
};

export type Health = {
  has_api_key: boolean;
  default_model: string;
  intent_model: string;
  models: ModelOption[];
  user_id: string;
};

export type ModelOption = { id: string; label: string };

export type Booking = {
  booking_id: string;
  provider_id: string;
  provider_name: string;
  service: string;
  slot: string;
  slot_label: string;
  price: number;
  status: string;
  when: "upcoming" | "past";
};

export type MemoryItem = {
  id: string;
  key: string;
  value: string;
  scope: string;
  source: "explicit" | "inferred";
  confirmed: boolean;
  status: "active" | "forgotten";
  updated_at: string;
};

export type Fixtures = {
  areas: string[];
  providers: {
    id: string;
    name: string;
    services: Record<string, number>;
    rating: number;
    areas: string[];
    price_change_on_hold: number;
    has_injection_review: boolean;
  }[];
  reschedule_conflict_times: string[];
};

export type SimState = {
  queued_book_outcomes: string[];
  price_change_on_hold: Record<string, number>;
  book_outcomes: string[];
};

export type ToolPart = {
  kind: "tool";
  seq: number;
  name: string;
  input: unknown;
  output: unknown;
  ok: boolean;
  latencyMs: number;
  executedBy: "agent" | "application";
};

export type MessagePart =
  | { kind: "text"; text: string }
  | ToolPart
  | { kind: "event"; event: string; detail: string; tone: "warn" | "ok" | "danger" | "info" }
  | { kind: "confirmation"; approval: Approval }
  | { kind: "system"; text: string }
  | { kind: "error"; message: string };

export type ChatMessage =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; parts: MessagePart[]; streaming: boolean }
  | { id: string; role: "notice"; text: string };
