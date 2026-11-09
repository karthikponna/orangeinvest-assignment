import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { BASE_SYSTEM_PROMPT } from "../agent/prompt";
import { config } from "../config";
import { isEligibleForContext, type MemoryStore } from "../memory/memoryStore";
import type { Intent, MemoryItem, Session } from "../types";
import { localNow, weekday } from "../util/time";

export const estimateTokens = (value: unknown) =>
  Math.ceil((typeof value === "string" ? value : JSON.stringify(value)).length / 4);

const AGENT_SERVICES = ["plumbing", "electrical", "ac_servicing"];

export interface ContextReport {
  budget_tokens: number;
  system_tokens_est: number;
  history_tokens_est: number;
  total_tokens_est: number;
  memories_sent: Array<{ id: string; key: string; scope: string; source: string }>;
  memories_excluded: { forgotten: number; inferred_unconfirmed: number; other_scope: number; over_budget: number };
  history_messages_sent: number;
  history_messages_dropped: number;
}

export interface BuiltContext {
  system: string;
  messages: MessageParam[];
  report: ContextReport;
}

function relevantScopes(session: Session): Set<string> {
  const scopes = new Set(["global"]);
  const service = session.state.request.service;
  if (service) scopes.add(service);
  const intent: Intent | undefined = session.state.intent;
  // Without a known service, existing-booking intents may touch any service the agent handles.
  if (!service && intent && intent !== "book_service") AGENT_SERVICES.forEach((s) => scopes.add(s));
  return scopes;
}

export function selectMemories(store: MemoryStore, session: Session) {
  const all = store.all(session.user_id, { includeForgotten: true });
  const scopes = relevantScopes(session);
  const excluded = { forgotten: 0, inferred_unconfirmed: 0, other_scope: 0, over_budget: 0 };
  const candidates: MemoryItem[] = [];

  for (const m of all) {
    if (m.status === "forgotten") excluded.forgotten++;
    else if (!isEligibleForContext(m)) excluded.inferred_unconfirmed++;
    else if (!scopes.has(m.scope)) excluded.other_scope++;
    else candidates.push(m);
  }

  // Service-specific facts first, then explicit before confirmed-inferred, newest first.
  candidates.sort(
    (a, b) =>
      Number(b.scope !== "global") - Number(a.scope !== "global") ||
      Number(b.source === "explicit") - Number(a.source === "explicit") ||
      b.updated_at.localeCompare(a.updated_at),
  );

  const selected: MemoryItem[] = [];
  let used = 0;
  for (const m of candidates) {
    const cost = estimateTokens(`${m.scope}.${m.key}: ${m.value}`) + 4;
    if (used + cost > config.context.memoryTokenBudget) {
      excluded.over_budget++;
      continue;
    }
    used += cost;
    selected.push(m);
  }
  return { selected, excluded };
}

function renderSystem(session: Session, memories: MemoryItem[], droppedMessages: number): string {
  const now = localNow();
  const memoryLines = memories.length
    ? memories
        .map((m) => `- ${m.scope}.${m.key}: ${m.value}${m.source === "inferred" ? " (inferred, user-confirmed)" : ""}`)
        .join("\n")
    : "- (none)";
  const state = {
    phase: session.state.phase,
    intent: session.state.intent ?? null,
    request: session.state.request,
    active_hold: session.state.active_hold ?? null,
    awaiting_user_confirmation: !!session.state.pending_approval_id,
  };
  return [
    BASE_SYSTEM_PROMPT,
    `\n## Now\nToday is ${weekday(now.date)} ${now.date}, local time ${now.time} (${config.timezone}). User id: ${session.user_id}.`,
    `\n## Known user preferences (from memory; current and confirmed only)\n${memoryLines}`,
    `\n## Workflow state (authoritative, maintained by the application)\n${JSON.stringify(state, null, 2)}`,
    droppedMessages
      ? `\n## Note\n${droppedMessages} older messages were omitted to fit the context budget; rely on the workflow state above for earlier details.`
      : "",
  ].join("\n");
}

/** A "turn" starts at a user message that the user (or application) typed, i.e. not only tool_result blocks. */
function isTurnStart(m: MessageParam): boolean {
  if (m.role !== "user") return false;
  if (typeof m.content === "string") return true;
  return m.content.some((b) => b.type === "text");
}

function trimHistory(messages: MessageParam[], budget: number) {
  const starts = messages.map((m, i) => (isTurnStart(m) ? i : -1)).filter((i) => i >= 0);
  let startIdx = starts[0] ?? 0;
  for (const s of starts) {
    startIdx = s;
    const slice = messages.slice(s);
    if (estimateTokens(slice) <= budget) break;
  }
  const sent = messages.slice(startIdx);
  // A leading user message may carry tool_results whose tool_use was trimmed away; drop those blocks.
  const first = sent[0];
  if (first && first.role === "user" && typeof first.content !== "string") {
    const kept = first.content.filter((b) => b.type !== "tool_result");
    sent[0] = { role: "user", content: kept.length ? kept : [{ type: "text", text: "[earlier context omitted]" }] };
  }
  return { sent, dropped: startIdx };
}

export function buildContext(store: MemoryStore, session: Session): BuiltContext {
  const { selected, excluded } = selectMemories(store, session);
  const draftSystem = renderSystem(session, selected, 0);
  const historyBudget = config.context.totalTokenBudget - config.context.reservedOutputTokens - estimateTokens(draftSystem) - 1500; // tool schemas
  const { sent, dropped } = trimHistory(session.messages, Math.max(historyBudget, 500));
  const system = dropped ? renderSystem(session, selected, dropped) : draftSystem;
  const systemTokens = estimateTokens(system);
  const historyTokens = estimateTokens(sent);

  return {
    system,
    messages: sent,
    report: {
      budget_tokens: config.context.totalTokenBudget,
      system_tokens_est: systemTokens,
      history_tokens_est: historyTokens,
      total_tokens_est: systemTokens + historyTokens + 1500,
      memories_sent: selected.map((m) => ({ id: m.id, key: m.key, scope: m.scope, source: m.source })),
      memories_excluded: excluded,
      history_messages_sent: sent.length,
      history_messages_dropped: dropped,
    },
  };
}
