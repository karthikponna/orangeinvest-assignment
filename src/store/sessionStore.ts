import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import type { MessageParam, Session } from "../types";
import { newId } from "../util/ids";
import { readJson, writeJsonAtomic } from "../util/jsonFile";
import { nowIso } from "../util/time";

function timestampSlug(d = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export class SessionStore {
  constructor(private readonly dir = config.paths.sessionsDir) {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  create(userId: string): Session {
    const id = newId("sess");
    const session: Session = {
      id,
      file_name: `${timestampSlug()}_${id}`,
      user_id: userId,
      created_at: nowIso(),
      updated_at: nowIso(),
      intent_verified: false,
      state: { phase: "idle", request: {} },
      messages: [],
      transcript: [],
    };
    this.save(session);
    return session;
  }

  save(session: Session): void {
    session.updated_at = nowIso();
    writeJsonAtomic(path.join(this.dir, `${session.file_name}.json`), session);
  }

  loadLatest(userId: string): Session | undefined {
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse();
    for (const f of files) {
      const s = readJson<Session | null>(path.join(this.dir, f), null);
      if (s && s.user_id === userId) return s;
    }
    return undefined;
  }

  get(sessionId: string): Session | undefined {
    const file = fs.readdirSync(this.dir).find((f) => f.endsWith(`_${sessionId}.json`));
    return file ? readJson<Session | null>(path.join(this.dir, file), null) ?? undefined : undefined;
  }

  filePath(session: Session): string {
    return path.join(this.dir, `${session.file_name}.json`);
  }
}

/**
 * Append a user-role message, merging into the previous user message when needed
 * (e.g. pending tool_result blocks followed by the user's next reply), because the
 * API expects user/assistant turns to alternate.
 */
export function pushUserContent(messages: MessageParam[], content: MessageParam["content"]): void {
  const blocks = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
  const last = messages[messages.length - 1];
  if (last && last.role === "user") {
    const existing = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content;
    last.content = [...existing, ...blocks];
    return;
  }
  messages.push({ role: "user", content: blocks });
}

export function pushAssistantText(messages: MessageParam[], text: string): void {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant") {
    const existing = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content;
    last.content = [...existing, { type: "text", text }];
    return;
  }
  if (!last) messages.push({ role: "user", content: [{ type: "text", text: "[conversation start]" }] });
  messages.push({ role: "assistant", content: [{ type: "text", text }] });
}
