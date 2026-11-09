import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";
import { config, useDataDir } from "../../src/config";
import { createDeps, ErrandApp, type AppDeps } from "../../src/orchestrator";
import type { OutputMessage } from "../../src/types";
import { ScriptedLLM } from "./scriptedLLM";

export const EVALS_DIR = path.resolve(import.meta.dir, "..");
const TMP_DIR = path.join(EVALS_DIR, ".tmp");

/** Fast, deterministic mock settings so the whole suite runs in seconds. */
export function configureForEvals() {
  config.seedMemories = true;
  config.mock.latencyMs = 0;
  config.mock.timeoutDelayMs = 5;
  config.mock.seed = 42;
  config.execution.retryBaseDelayMs = 1;
}

export type TraceEvent = { seq: number; type: string; [k: string]: any };

/** One isolated world per scenario: own data folder, own mock provider, own scripted model. */
export class Env {
  readonly dir: string;
  readonly llm = new ScriptedLLM();
  deps: AppDeps;
  app: ErrandApp;
  readonly turns: Array<{ input: string; outputs: OutputMessage[] }> = [];
  readonly violations: string[] = [];

  constructor(readonly id: string) {
    this.dir = path.join(TMP_DIR, `${id}-${Date.now().toString(36)}`);
    fs.rmSync(this.dir, { recursive: true, force: true });
    useDataDir(this.dir);
    this.deps = createDeps({ llm: this.llm });
    this.app = new ErrandApp(this.deps);
  }

  /** Simulated user turn. Every turn must produce at least one user-facing message. */
  async say(text: string): Promise<OutputMessage[]> {
    const outputs = await this.app.handleUserMessage(text);
    this.turns.push({ input: text, outputs });
    if (!outputs.length) this.violations.push(`turn "${text}" produced no user-facing message`);
    return outputs;
  }

  /** Background check for provider events (what the CLI/web poller does). */
  async poll(): Promise<OutputMessage[]> {
    const outputs = await this.app.pollEvents();
    this.turns.push({ input: "[poll]", outputs });
    return outputs;
  }

  /** Simulates a process restart: fresh objects reading the same files, then startup recovery. */
  async restart(): Promise<OutputMessage[]> {
    useDataDir(this.dir);
    this.deps = createDeps({ llm: this.llm });
    this.app = new ErrandApp(this.deps, { sessionId: this.app.session.id });
    const outputs = await this.app.startup();
    this.turns.push({ input: "[restart]", outputs });
    return outputs;
  }

  trace(): TraceEvent[] {
    return this.app.tracer.readAll() as TraceEvent[];
  }

  traceOf(type: string): TraceEvent[] {
    return this.trace().filter((e) => e.type === type);
  }

  toolCalls(tool: string): TraceEvent[] {
    return this.traceOf("tool_call").filter((e) => e.tool === tool);
  }

  /** Bookings created by `book` during this scenario (seeded history excluded). */
  newBookings() {
    return this.deps.provider.allBookings().filter((b) => b.hold_id);
  }

  allText(): string {
    return this.turns.flatMap((t) => t.outputs.map((o) => o.text)).join("\n");
  }

  lastOutputs(): OutputMessage[] {
    return this.turns.at(-1)?.outputs ?? [];
  }

  cleanup() {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * Invariants checked after every scenario, independent of wording:
 *  1. no booking without a consumed approval whose provider, slot and price match it
 *  2. at most one booking per approval and per hold
 *  3. no "Booked and verified" message for a booking the provider doesn't have
 *  4. every user turn produced a user-facing message
 *  5. every model request stayed within the context token budget
 */
export function checkInvariants(env: Env): string[] {
  const v = [...env.violations];
  const bookings = env.newBookings();
  const actions = env.deps.ledger.allActions();
  const approvals = env.deps.ledger.allApprovals();

  for (const b of bookings) {
    const action = actions.find((a) => a.type === "book" && a.booking_id === b.booking_id);
    const approval = approvals.find((a) => a.id === action?.approval_id);
    if (!action || !approval) {
      v.push(`booking ${b.booking_id} has no approved action`);
      continue;
    }
    if (approval.status !== "consumed") v.push(`booking ${b.booking_id} used approval in status ${approval.status}`);
    const d = approval.details;
    if (d.provider_id !== b.provider_id || d.slot !== b.slot || d.price !== b.price) {
      v.push(`booking ${b.booking_id} differs from what was approved (${d.provider_id}/${d.slot}/₹${d.price} vs ${b.provider_id}/${b.slot}/₹${b.price})`);
    }
  }

  const perApproval = new Map<string, number>();
  for (const a of actions.filter((x) => x.type === "book" && x.booking_id)) perApproval.set(a.approval_id, (perApproval.get(a.approval_id) ?? 0) + 1);
  for (const [id, n] of perApproval) if (n > 1) v.push(`approval ${id} produced ${n} bookings`);
  const perHold = new Map<string, number>();
  for (const b of bookings) perHold.set(b.hold_id!, (perHold.get(b.hold_id!) ?? 0) + 1);
  for (const [id, n] of perHold) if (n > 1) v.push(`hold ${id} produced ${n} bookings`);

  const known = new Set(env.deps.provider.allBookings().map((b) => b.booking_id));
  for (const m of env.allText().matchAll(/Booked and verified: (B-\d+)/g)) {
    if (!known.has(m[1]!)) v.push(`claimed booking ${m[1]} does not exist at the provider`);
  }

  for (const e of env.traceOf("context_sent")) {
    if (e.total_tokens_est > e.budget_tokens) v.push(`context ${e.total_tokens_est} tokens exceeded budget ${e.budget_tokens}`);
  }
  return v;
}

// ───────────── Results → generated eval table ─────────────

export interface ScenarioResult {
  id: string;
  name: string;
  covers: string;
  expected: string;
  actual: string;
  pass: boolean;
  notes: string;
  ms: number;
}

export const results: ScenarioResult[] = [];

export interface ScenarioDef {
  id: string;
  name: string;
  covers: string;
  expected: string;
}

/**
 * Registers one eval. `run` drives the simulated user and asserts outcomes; it returns a
 * short "actual" description for the table. Invariants are checked afterwards for every scenario.
 */
export function scenario(def: ScenarioDef, run: (env: Env) => Promise<string>) {
  test(`${def.id} ${def.name}`, async () => {
    const started = Date.now();
    const env = new Env(def.id);
    let actual = "";
    let notes = "";
    let pass = false;
    try {
      actual = await run(env);
      const broken = checkInvariants(env);
      if (broken.length) throw new Error(`invariant violated: ${broken.join("; ")}`);
      pass = true;
    } catch (err) {
      notes = (err as Error).message.split("\n")[0]!.slice(0, 300);
      if (!actual) actual = env.lastOutputs().map((o) => o.text.split("\n")[0]).join(" / ").slice(0, 200) || "(no output)";
      throw err;
    } finally {
      results.push({ ...def, actual, pass, notes, ms: Date.now() - started });
      env.cleanup();
    }
  });
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function writeReport() {
  const passed = results.filter((r) => r.pass).length;
  const lines = [
    "# Eval results",
    "",
    `Generated by \`bun run evals\` on ${new Date().toISOString()} — **${passed}/${results.length} passed**.`,
    "Model: scripted (offline). Every scenario also checks these invariants: no booking without a matching approval;",
    "at most one booking per approval/hold; no success claim the provider can't confirm; every turn answers the user;",
    "every model request within the context token budget.",
    "",
    "| # | Scenario | Covers | Expected | Actual | Result | Notes |",
    "|---|---|---|---|---|---|---|",
    ...results.map((r) => `| ${r.id} | ${esc(r.name)} | ${esc(r.covers)} | ${esc(r.expected)} | ${esc(r.actual)} | ${r.pass ? "✅ pass" : "❌ fail"} | ${esc(r.notes)} |`),
    "",
  ];
  fs.writeFileSync(path.join(EVALS_DIR, "results.md"), lines.join("\n"));
  fs.writeFileSync(path.join(EVALS_DIR, "results.json"), JSON.stringify(results, null, 2));
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}
