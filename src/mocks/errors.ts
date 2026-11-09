export type ToolErrorCode =
  | "invalid_input"
  | "not_found"
  | "slot_unavailable"
  | "slot_taken"
  | "slot_conflict"
  | "hold_expired"
  | "hold_already_used"
  | "timeout"
  | "service_unavailable"
  | "invalid_state"
  | "approval_required"
  | "limit_exceeded"
  | "internal_error";

export class ToolError extends Error {
  constructor(
    public code: ToolErrorCode,
    message: string,
    public retryable = false,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolError";
  }

  toJSON() {
    return { error: this.code, message: this.message, retryable: this.retryable, ...(this.details ?? {}) };
  }
}

export function asToolError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  return new ToolError("internal_error", err instanceof Error ? err.message : String(err), false);
}
