import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, MessageParam, StopReason, Tool, ToolChoice } from "@anthropic-ai/sdk/resources/messages";
import { config } from "../config";

export interface LLMRequest {
  model: string;
  system: string;
  messages: MessageParam[];
  tools?: Tool[];
  tool_choice?: ToolChoice;
  max_tokens: number;
}

export interface LLMResponse {
  model: string;
  content: ContentBlock[];
  stop_reason: StopReason | null;
  usage: { input_tokens: number; output_tokens: number };
}

/** Seam for swapping the real model with a scripted one in offline evals. */
export interface LLMClient {
  create(req: LLMRequest): Promise<LLMResponse>;
}

export class AnthropicLLMClient implements LLMClient {
  private client: Anthropic;

  constructor(apiKey = config.apiKey) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: config.limits.modelRequestTimeoutMs });
  }

  async create(req: LLMRequest): Promise<LLMResponse> {
    const res = await this.client.messages.create({
      model: req.model,
      system: req.system,
      messages: req.messages,
      max_tokens: req.max_tokens,
      ...(req.tools ? { tools: req.tools } : {}),
      ...(req.tool_choice ? { tool_choice: req.tool_choice } : {}),
    });
    return {
      model: res.model,
      content: res.content,
      stop_reason: res.stop_reason,
      usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens },
    };
  }
}
