import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { config } from "../config";
import { buildContext } from "../context/contextBuilder";
import type { MemoryStore } from "../memory/memoryStore";
import { pushUserContent } from "../store/sessionStore";
import type { Tracer } from "../trace/tracer";
import type { Approval, Session } from "../types";
import type { LLMClient } from "./llm";
import { AGENT_TOOLS, dispatchTool, type ToolDeps } from "./tools";

export interface AgentRunResult {
  texts: string[];
  approval?: Approval;
  exit: "completed" | "awaiting_approval" | "limit_model_calls" | "limit_tool_calls" | "limit_wall_clock" | "model_error" | "refusal";
}

export interface AgentDeps extends ToolDeps {
  llm: LLMClient;
  memory: MemoryStore;
  model?: string;
  onToolCall?: (name: string, input: unknown) => void;
}

const LIMIT_MESSAGES: Partial<Record<AgentRunResult["exit"], string>> = {
  limit_model_calls: "I've hit my step limit for this request without finishing. Nothing was booked or changed. Could you narrow it down (e.g. one provider or one day)?",
  limit_tool_calls: "I've hit my tool-call limit for this request. Nothing was booked or changed. Please try a more specific request.",
  limit_wall_clock: "This is taking too long, so I stopped. Nothing was booked or changed. Please try again.",
  refusal: "I can't help with that request.",
};

/**
 * One bounded agent run: model ↔ tools until the model replies, requests approval,
 * or a hard limit is hit. Every exit path yields a user-facing message.
 */
export async function runAgent(session: Session, deps: AgentDeps, tracer: Tracer): Promise<AgentRunResult> {
  const { limits } = config;
  const started = Date.now();
  const texts: string[] = [];
  let modelCalls = 0;
  let toolCalls = 0;

  const finish = (exit: AgentRunResult["exit"], approval?: Approval, error?: string): AgentRunResult => {
    tracer.event("agent_exit", { exit, model_calls: modelCalls, tool_calls: toolCalls, ...(error ? { error } : {}) });
    const msg = LIMIT_MESSAGES[exit];
    if (msg) texts.push(msg);
    if (exit === "model_error") texts.push(`Sorry — I couldn't reach the AI model (${error}). Nothing was booked or changed. Please try again.`);
    return { texts, approval, exit };
  };

  while (true) {
    if (modelCalls >= limits.maxModelCallsPerRun) return finish("limit_model_calls");
    if (Date.now() - started > limits.maxWallClockMsPerRun) return finish("limit_wall_clock");

    const ctx = buildContext(deps.memory, session);
    tracer.event("context_sent", { ...ctx.report });

    const callStarted = Date.now();
    let res;
    try {
      res = await deps.llm.create({
        model: deps.model ?? config.agentModel,
        system: ctx.system,
        messages: ctx.messages,
        tools: AGENT_TOOLS,
        max_tokens: limits.maxOutputTokens,
      });
    } catch (err) {
      tracer.event("model_error", { error: (err as Error).message, latency_ms: Date.now() - callStarted });
      return finish("model_error", undefined, (err as Error).message);
    }
    modelCalls++;
    tracer.recordModelCall({
      purpose: "agent",
      model: res.model,
      latency_ms: Date.now() - callStarted,
      input_tokens: res.usage.input_tokens,
      output_tokens: res.usage.output_tokens,
      stop_reason: res.stop_reason,
    });

    session.messages.push({ role: "assistant", content: res.content });
    for (const b of res.content) if (b.type === "text" && b.text.trim()) texts.push(b.text.trim());

    if (res.stop_reason === "refusal") return finish("refusal");
    const toolUses = res.content.filter((b) => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || toolUses.length === 0) return finish("completed");

    const results: ToolResultBlockParam[] = [];
    let approval: Approval | undefined;
    for (const tu of toolUses) {
      if (tu.type !== "tool_use") continue;
      if (toolCalls >= limits.maxToolCallsPerRun || Date.now() - started > limits.maxWallClockMsPerRun) {
        results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: JSON.stringify({ error: "limit_exceeded", message: "Tool budget exhausted for this request." }) });
        continue;
      }
      toolCalls++;
      deps.onToolCall?.(tu.name, tu.input);
      const r = await dispatchTool(tu.name, tu.input, session, deps, tracer);
      if (r.approval) approval = r.approval;
      results.push({ type: "tool_result", tool_use_id: tu.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
    }
    pushUserContent(session.messages, results);

    if (approval) return finish("awaiting_approval", approval);
    if (toolCalls >= limits.maxToolCallsPerRun) return finish("limit_tool_calls");
  }
}
