import type { ContentBlock, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { LLMClient, LLMRequest, LLMResponse } from "../../src/agent/llm";
import { addDays, localNow } from "../../src/util/time";
import type { Intent } from "../../src/types";

export type Step = (req: LLMRequest) => LLMResponse;

let toolIds = 0;

const usage = (req?: LLMRequest) => ({
  input_tokens: req ? Math.ceil((req.system.length + JSON.stringify(req.messages).length) / 4) : 0,
  output_tokens: 20,
});

export function toolCalls(calls: Array<{ name: string; input: unknown }>, text?: string): LLMResponse {
  const content: ContentBlock[] = [];
  if (text) content.push({ type: "text", text, citations: null } as ContentBlock);
  for (const c of calls) {
    content.push({ type: "tool_use", id: `toolu_scripted_${++toolIds}`, name: c.name, input: c.input, caller: { type: "direct" } } as ContentBlock);
  }
  return { model: "scripted", stop_reason: "tool_use", usage: usage(), content };
}

export function textReply(text: string): LLMResponse {
  return { model: "scripted", stop_reason: "end_turn", usage: usage(), content: [{ type: "text", text, citations: null } as ContentBlock] };
}

/**
 * Offline stand-in for Claude. Agent calls are answered from a queue of scripted steps;
 * intent-classifier calls are answered from `intent`. Every request is recorded so tests
 * can assert exactly what context the model would have seen.
 */
export class ScriptedLLM implements LLMClient {
  intent: Intent = "book_service";
  intentReply = "I can help with plumbing, electrical and AC servicing bookings. What do you need?";
  /** Used when the queue is empty, e.g. to simulate a model that never stops calling tools. */
  loopStep?: Step;
  failWith?: Error;
  readonly requests: LLMRequest[] = [];
  private queue: Step[] = [];

  script(...steps: Step[]) {
    this.queue.push(...steps);
    return this;
  }

  get pending() {
    return this.queue.length;
  }

  get agentRequests() {
    return this.requests.filter((r) => !r.tool_choice);
  }

  async create(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(structuredClone(req));
    if (req.tool_choice && "name" in req.tool_choice && req.tool_choice.name === "classify_intent") {
      const relevant = this.intent !== "off_topic" && this.intent !== "greeting";
      return {
        ...toolCalls([{ name: "classify_intent", input: relevant ? { intent: this.intent } : { intent: this.intent, reply: this.intentReply } }]),
        usage: usage(req),
      };
    }
    if (this.failWith) throw this.failWith;
    const step = this.queue.shift() ?? this.loopStep;
    if (!step) throw new Error("ScriptedLLM: script exhausted (the agent made more model calls than the scenario planned)");
    return { ...step(req), usage: usage(req) };
  }
}

// ───────────── Reading the conversation the model would see ─────────────

/** Latest tool result for `toolName`, unwrapped from the untrusted-data envelope. */
export function toolResult(req: LLMRequest | MessageParam[], toolName: string): any {
  const messages = Array.isArray(req) ? req : req.messages;
  const names = new Map<string, string>();
  let found: any;
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_use") names.set(b.id, b.name);
      if (b.type === "tool_result" && names.get(b.tool_use_id) === toolName) {
        const parsed = JSON.parse(String(b.content));
        found = parsed?.trust === "untrusted_external_data" ? parsed.data : parsed;
      }
    }
  }
  return found;
}

export function lastUserText(req: LLMRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    const texts = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
    if (texts.length) return texts.join("\n");
  }
  return "";
}

// ───────────── Reusable steps ─────────────

export const nextWeek = () => {
  const today = localNow().date;
  return { from: addDays(today, 1), to: addDays(today, 7) };
};

export const step = {
  tool:
    (name: string, input: unknown, text?: string): Step =>
    () =>
      toolCalls([{ name, input }], text),
  say:
    (text: string): Step =>
    () =>
      textReply(text),
  search:
    (service: string, area = "Indiranagar"): Step =>
    () =>
      toolCalls([{ name: "search_providers", input: { service, area, date_range: nextWeek() } }]),
  /** Hold slot number `index` of `providerId` from the most recent search. */
  hold:
    (providerId: string, index = 0): Step =>
    (req) => {
      const search = toolResult(req, "search_providers");
      const provider = search?.providers?.find((p: any) => p.provider_id === providerId);
      if (!provider?.available_slots?.[index]) throw new Error(`No slot #${index} for ${providerId} in the last search`);
      return toolCalls([{ name: "hold_slot", input: { provider_id: providerId, slot: provider.available_slots[index].slot } }]);
    },
  requestBookingApproval: (): Step => (req) => {
    const hold = toolResult(req, "hold_slot");
    if (!hold?.hold_id) throw new Error("No hold to request approval for");
    return toolCalls([{ name: "request_approval", input: { action: "book", hold_id: hold.hold_id } }]);
  },
  /** Run an assertion against what the model sees, then reply. */
  check:
    (assert: (req: LLMRequest) => void, reply = "OK."): Step =>
    (req) => {
      assert(req);
      return textReply(reply);
    },
};

/** search → hold → request_approval: the standard path to a confirmation card. */
export function bookingFlow(service: string, providerId: string, slotIndex = 0): Step[] {
  return [step.search(service), step.hold(providerId, slotIndex), step.requestBookingApproval()];
}
