import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

export type { MessageParam };

export const SERVICES = ["plumbing", "electrical", "ac_servicing"] as const;
export type Service = (typeof SERVICES)[number];

export const INTENTS = [
  "book_service",
  "reschedule_booking",
  "cancel_booking",
  "view_bookings",
  "manage_memory",
  "greeting",
  "off_topic",
] as const;
export type Intent = (typeof INTENTS)[number];

export type Phase =
  | "idle"
  | "collecting"
  | "searching"
  | "holding"
  | "awaiting_approval"
  | "executing"
  | "done"
  | "failed";

export interface ServiceRequest {
  service?: string;
  area?: string;
  date_from?: string;
  date_to?: string;
  earliest_time?: string;
  latest_time?: string;
  budget_max?: number;
  preferred_provider_id?: string;
  target_booking_id?: string;
  notes?: string[];
}

export interface ActiveHold {
  hold_id: string;
  provider_id: string;
  provider_name: string;
  service: string;
  slot: string;
  quoted_price: number;
  search_price: number;
  expires_at: string;
}

export interface WorkflowState {
  phase: Phase;
  intent?: Intent;
  request: ServiceRequest;
  active_hold?: ActiveHold;
  pending_approval_id?: string;
  last_executed_action_id?: string;
  last_output_kind?: "agent" | "confirmation" | "execution_result" | "system";
}

export interface TranscriptEntry {
  at: string;
  role: "user" | "assistant" | "system" | "confirmation";
  text: string;
}

export interface Session {
  id: string;
  file_name: string;
  user_id: string;
  created_at: string;
  updated_at: string;
  intent_verified: boolean;
  state: WorkflowState;
  messages: MessageParam[];
  transcript: TranscriptEntry[];
}

export type ApprovalAction = "book" | "cancel" | "reschedule";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "superseded" | "invalidated" | "consumed";

export interface ApprovalDetails {
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
}

export interface Approval {
  id: string;
  session_id: string;
  user_id: string;
  action: ApprovalAction;
  details: ApprovalDetails;
  status: ApprovalStatus;
  created_at: string;
  decided_at?: string;
  status_reason?: string;
}

export type ActionStatus = "executing" | "succeeded" | "failed";

export interface ActionRecord {
  id: string;
  approval_id: string;
  session_id: string;
  user_id: string;
  type: ApprovalAction;
  idempotency_key: string;
  status: ActionStatus;
  attempts: number;
  booking_id?: string;
  outcome?: string;
  error?: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryItem {
  id: string;
  user_id: string;
  key: string;
  value: string;
  scope: string;
  source: "explicit" | "inferred";
  confirmed: boolean;
  status: "active" | "forgotten";
  created_at: string;
  updated_at: string;
  history: { value: string; at: string; source: string }[];
}

export interface OutputMessage {
  kind: "assistant" | "confirmation" | "system" | "error" | "progress";
  text: string;
  approval?: Approval;
}
