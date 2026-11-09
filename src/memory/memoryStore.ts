import { config } from "../config";
import type { MemoryItem } from "../types";
import { newId } from "../util/ids";
import { readJson, writeJsonAtomic } from "../util/jsonFile";
import { nowIso } from "../util/time";
import { SEED_MEMORIES } from "./seed";

interface MemoryFile {
  items: MemoryItem[];
}

const norm = (s: string) => String(s ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");

/** Facts eligible for model context: active, and either stated by the user or confirmed by them. */
export function isEligibleForContext(m: MemoryItem): boolean {
  return m.status === "active" && (m.source === "explicit" || m.confirmed);
}

export class MemoryStore {
  private data: MemoryFile;

  constructor(
    private readonly file = config.paths.memoryFile,
    seedUserId = config.userId,
    seedMemories = config.seedMemories,
  ) {
    const existing = readJson<MemoryFile | null>(file, null);
    this.data = existing ?? { items: seedMemories ? this.seed(seedUserId) : [] };
    if (!existing) this.persist();
  }

  private seed(userId: string): MemoryItem[] {
    return SEED_MEMORIES.map((m) => ({
      ...m,
      id: newId("mem"),
      user_id: userId,
      created_at: nowIso(),
      updated_at: nowIso(),
      history: [],
    }));
  }

  private persist() {
    writeJsonAtomic(this.file, this.data);
  }

  all(userId: string, opts: { includeForgotten?: boolean } = {}): MemoryItem[] {
    return this.data.items.filter((m) => m.user_id === userId && (opts.includeForgotten || m.status === "active"));
  }

  find(userId: string, idOrKey: string, scope?: string): MemoryItem[] {
    const q = norm(idOrKey);
    return this.all(userId).filter(
      (m) => m.id === idOrKey || (norm(m.key) === q && (!scope || norm(m.scope) === norm(scope))),
    );
  }

  /** Create or correct a fact. A correction replaces the value but keeps an audit history. */
  upsert(userId: string, input: { key: string; value: string; scope?: string; source: "explicit" | "inferred" }): MemoryItem {
    const key = norm(input.key);
    const scope = norm(input.scope || "global");
    const existing = this.all(userId).find((m) => norm(m.key) === key && norm(m.scope) === scope);
    if (existing) {
      if (existing.value !== input.value) {
        existing.history.push({ value: existing.value, at: existing.updated_at, source: existing.source });
      }
      existing.value = input.value;
      // An explicit statement upgrades an inferred fact; an inference never downgrades an explicit one.
      if (input.source === "explicit") {
        existing.source = "explicit";
        existing.confirmed = true;
      }
      existing.updated_at = nowIso();
      this.persist();
      return existing;
    }
    const item: MemoryItem = {
      id: newId("mem"),
      user_id: userId,
      key,
      value: input.value,
      scope,
      source: input.source,
      confirmed: input.source === "explicit",
      status: "active",
      created_at: nowIso(),
      updated_at: nowIso(),
      history: [],
    };
    this.data.items.push(item);
    this.persist();
    return item;
  }

  /** Forgetting wipes the value (and its history) so it can never be sent to the model again. */
  forget(userId: string, idOrKey: string, scope?: string): MemoryItem[] {
    const matches = this.find(userId, idOrKey, scope);
    for (const m of matches) {
      m.status = "forgotten";
      m.value = "";
      m.history = [];
      m.updated_at = nowIso();
    }
    if (matches.length) this.persist();
    return matches;
  }

  confirm(userId: string, id: string): MemoryItem | undefined {
    const m = this.all(userId).find((x) => x.id === id);
    if (!m) return undefined;
    m.confirmed = true;
    m.updated_at = nowIso();
    this.persist();
    return m;
  }

  edit(userId: string, id: string, value: string): MemoryItem | undefined {
    const m = this.all(userId).find((x) => x.id === id);
    if (!m) return undefined;
    return this.upsert(userId, { key: m.key, scope: m.scope, value, source: "explicit" });
  }
}
