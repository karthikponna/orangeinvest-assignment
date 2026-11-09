import { config } from "../config";
import type { ActionRecord, Approval, ApprovalStatus } from "../types";
import { newId } from "../util/ids";
import { readJson, writeJsonAtomic } from "../util/jsonFile";
import { nowIso } from "../util/time";

interface LedgerFile {
  approvals: Record<string, Approval>;
  actions: Record<string, ActionRecord>;
}

/**
 * Durable record of approvals and side-effecting actions (with their idempotency keys).
 * Lives outside session files because bookings outlive sessions and restart recovery
 * needs a single place to find in-flight actions.
 */
export class Ledger {
  private data: LedgerFile;

  constructor(private readonly file = config.paths.ledgerFile) {
    this.data = readJson<LedgerFile>(file, { approvals: {}, actions: {} });
  }

  private persist() {
    writeJsonAtomic(this.file, this.data);
  }

  createApproval(input: Omit<Approval, "id" | "created_at" | "status">): Approval {
    const approval: Approval = { ...input, id: newId("apr"), status: "pending", created_at: nowIso() };
    this.data.approvals[approval.id] = approval;
    this.persist();
    return approval;
  }

  getApproval(id: string | undefined): Approval | undefined {
    return id ? this.data.approvals[id] : undefined;
  }

  setApprovalStatus(id: string, status: ApprovalStatus, reason?: string): Approval {
    const a = this.data.approvals[id];
    if (!a) throw new Error(`Approval ${id} not found`);
    a.status = status;
    a.decided_at = nowIso();
    if (reason) a.status_reason = reason;
    this.persist();
    return a;
  }

  updateApprovalDetails(id: string, patch: Partial<Approval["details"]>): Approval {
    const a = this.data.approvals[id];
    if (!a) throw new Error(`Approval ${id} not found`);
    a.details = { ...a.details, ...patch };
    this.persist();
    return a;
  }

  pendingApprovalsForSession(sessionId: string): Approval[] {
    return Object.values(this.data.approvals).filter((a) => a.session_id === sessionId && a.status === "pending");
  }

  /** Must be called (and persisted) BEFORE the side-effecting call is made. */
  startAction(input: Omit<ActionRecord, "id" | "status" | "attempts" | "created_at" | "updated_at">): ActionRecord {
    const action: ActionRecord = {
      ...input,
      id: newId("act"),
      status: "executing",
      attempts: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.data.actions[action.id] = action;
    this.persist();
    return action;
  }

  updateAction(id: string, patch: Partial<ActionRecord>): ActionRecord {
    const a = this.data.actions[id];
    if (!a) throw new Error(`Action ${id} not found`);
    Object.assign(a, patch, { updated_at: nowIso() });
    this.persist();
    return a;
  }

  getAction(id: string | undefined): ActionRecord | undefined {
    return id ? this.data.actions[id] : undefined;
  }

  actionForApproval(approvalId: string): ActionRecord | undefined {
    return Object.values(this.data.actions).find((a) => a.approval_id === approvalId);
  }

  allApprovals(): Approval[] {
    return Object.values(this.data.approvals);
  }

  allActions(): ActionRecord[] {
    return Object.values(this.data.actions);
  }

  inFlightActions(userId: string): ActionRecord[] {
    return Object.values(this.data.actions).filter((a) => a.user_id === userId && a.status === "executing");
  }
}
