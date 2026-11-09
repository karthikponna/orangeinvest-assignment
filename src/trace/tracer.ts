import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { newId } from "../util/ids";
import { appendJsonLine } from "../util/jsonFile";

export interface RunTotals {
  model_calls: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  est_cost_usd: number;
}

const SECRET_KEYS = /api[_-]?key|authorization|token$|password|secret/i;

/** Redact secrets and clip long strings so traces stay readable and safe to share. */
export function sanitizeForTrace(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth-limit]";
  if (typeof value === "string") return value.length > 600 ? `${value.slice(0, 600)}…[+${value.length - 600} chars]` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeForTrace(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) && k !== "output_tokens" && k !== "input_tokens" ? "[redacted]" : sanitizeForTrace(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = config.pricing.find((p) => model.startsWith(p.prefix));
  if (!price) return 0;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/** Writes one JSON line per event to data/traces/<session file>.jsonl. */
export class Tracer {
  readonly file: string;
  private runId: string | null = null;
  private seq = 0;
  private runStartedAt = 0;
  private listeners = new Set<(event: Record<string, unknown>) => void>();
  totals: RunTotals = this.emptyTotals();

  constructor(sessionFileName: string, private readonly sessionId: string) {
    this.file = path.join(config.paths.tracesDir, `${sessionFileName}.jsonl`);
    if (fs.existsSync(this.file)) {
      const lines = fs.readFileSync(this.file, "utf8").trim().split("\n").filter(Boolean);
      this.seq = lines.length;
    }
  }

  private emptyTotals(): RunTotals {
    return { model_calls: 0, tool_calls: 0, input_tokens: 0, output_tokens: 0, est_cost_usd: 0 };
  }

  /** Live feed of trace events (used by the web server to stream the trace panel). */
  subscribe(fn: (event: Record<string, unknown>) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  readAll(): Record<string, unknown>[] {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  event(type: string, data: Record<string, unknown> = {}): void {
    const base = { ts: new Date().toISOString(), session_id: this.sessionId, run_id: this.runId, seq: ++this.seq, type };
    // Reserved fields win over same-named data keys.
    const entry: Record<string, unknown> = { ...base, ...(sanitizeForTrace(data) as Record<string, unknown>), ...base };
    appendJsonLine(this.file, entry);
    for (const fn of this.listeners) fn(entry);
  }

  startRun(trigger: string, input: string): string {
    this.runId = newId("run");
    this.runStartedAt = Date.now();
    this.totals = this.emptyTotals();
    this.event("run_start", { trigger, input });
    return this.runId;
  }

  recordModelCall(data: { purpose: string; model: string; latency_ms: number; input_tokens: number; output_tokens: number; stop_reason: string | null }) {
    const cost = estimateCostUsd(data.model, data.input_tokens, data.output_tokens);
    this.totals.model_calls += 1;
    this.totals.input_tokens += data.input_tokens;
    this.totals.output_tokens += data.output_tokens;
    this.totals.est_cost_usd += cost;
    this.event("model_call", { ...data, est_cost_usd: Number(cost.toFixed(6)) });
  }

  recordToolCall(data: { tool: string; args: unknown; latency_ms: number; ok: boolean; result: unknown; executed_by: "agent" | "application" }) {
    this.totals.tool_calls += 1;
    this.event("tool_call", data);
  }

  transition(from: string, to: string, reason: string) {
    if (from !== to) this.event("state_transition", { from, to, reason });
  }

  endRun(outcome: string, extra: Record<string, unknown> = {}) {
    this.event("run_end", {
      outcome,
      wall_clock_ms: Date.now() - this.runStartedAt,
      ...this.totals,
      est_cost_usd: Number(this.totals.est_cost_usd.toFixed(6)),
      ...extra,
    });
    this.runId = null;
  }
}
