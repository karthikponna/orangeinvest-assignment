import fs from "node:fs";
import path from "node:path";

export const ROOT_DIR = path.resolve(import.meta.dir, "..");

function loadEnvFile(file: string) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

// Bun only auto-loads .env from the cwd; apps/* run from their own folder.
loadEnvFile(path.join(ROOT_DIR, ".env"));

const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT_DIR, "data");

export const config = {
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  agentModel: process.env.AGENT_MODEL || "claude-sonnet-5-5",
  intentModel: process.env.INTENT_MODEL || "claude-haiku-5-5",
  userId: process.env.USER_ID || "u1",
  // Only read when data/memory.json does not exist yet (first run or after `bun run reset-data`).
  seedMemories: process.env.SEED_MEMORIES !== "false",
  timezone: "Asia/Kolkata",

  paths: {
    dataDir,
    sessionsDir: path.join(dataDir, "sessions"),
    tracesDir: path.join(dataDir, "traces"),
    memoryFile: path.join(dataDir, "memory.json"),
    ledgerFile: path.join(dataDir, "actions.json"),
    mockStateFile: path.join(dataDir, "mock_provider_state.json"),
  },

  limits: {
    maxModelCallsPerRun: 10,
    maxToolCallsPerRun: 20,
    maxWallClockMsPerRun: 120_000,
    modelRequestTimeoutMs: 60_000,
    maxOutputTokens: 1024,
  },

  context: {
    totalTokenBudget: 12_000,
    memoryTokenBudget: 800,
    reservedOutputTokens: 1024,
  },

  execution: {
    maxBookAttempts: 3,
    maxCancelAttempts: 3,
    maxRescheduleAttempts: 3,
    retryBaseDelayMs: 300,
  },

  mock: {
    seed: Number(process.env.MOCK_SEED ?? 42),
    latencyMs: 120,
    timeoutDelayMs: 1200,
    holdTtlMs: 10 * 60_000,
    // provider_id -> fractional price increase applied when a slot is held
    priceChangeOnHold: { P1: 0.15 } as Record<string, number>,
    rescheduleConflictTimes: ["09:00", "16:00"],
    bookOutcomeRates: { success: 0.7, slotTaken: 0.15, timeout: 0.15 },
    timeoutBookedFraction: 0.5,
  },

  // Estimated USD per 1M tokens, matched by model-name prefix.
  pricing: [
    { prefix: "claude-haiku", input: 1, output: 5 },
    { prefix: "claude-sonnet", input: 3, output: 15 },
    { prefix: "claude-opus", input: 5, output: 25 },
  ],
};

export type AppConfig = typeof config;

/** Point every store at a different data folder (used by the offline evals for isolation). */
export function useDataDir(dir: string): void {
  const root = path.resolve(dir);
  Object.assign(config.paths, {
    dataDir: root,
    sessionsDir: path.join(root, "sessions"),
    tracesDir: path.join(root, "traces"),
    memoryFile: path.join(root, "memory.json"),
    ledgerFile: path.join(root, "actions.json"),
    mockStateFile: path.join(root, "mock_provider_state.json"),
  });
}
