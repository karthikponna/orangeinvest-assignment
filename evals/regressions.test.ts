import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { useDataDir } from "../src/config";
import { Tracer } from "../src/trace/tracer";

const ROOT = path.resolve(import.meta.dir, "..");

function filesUnder(dir: string, ext: RegExp): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : filesUnder(p, ext);
    return ext.test(e.name) ? [p] : [];
  });
}

describe("regressions", () => {
  test("BUG-1: event data cannot overwrite a trace event's own type/seq", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "errand-trace-"));
    useDataDir(dir);
    const tracer = new Tracer("regression", "sess_test");
    tracer.event("action_started", { type: "book", seq: 999, idempotency_key: "k1" });
    const [e] = tracer.readAll();
    expect(e!.type).toBe("action_started");
    expect(e!.seq).toBe(1);
    expect(e!.idempotency_key).toBe("k1");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("BUG-2: every env var the apps read is passed through by turbo", () => {
    const turbo = JSON.parse(fs.readFileSync(path.join(ROOT, "turbo.json"), "utf8"));
    const passed = new Set<string>(turbo.globalPassThroughEnv ?? []);
    const sources = [path.join(ROOT, "src/config.ts"), path.join(ROOT, "apps/server/src/index.ts")];
    const used = new Set(sources.flatMap((f) => [...fs.readFileSync(f, "utf8").matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]!)));
    const missing = [...used].filter((v) => !passed.has(v));
    expect(missing).toEqual([]);
  });

  test("BUG-3: no useEffect callback returns a value (React treats it as a cleanup function)", () => {
    const offenders = filesUnder(path.join(ROOT, "apps/web/src"), /\.tsx?$/).flatMap((f) =>
      [...fs.readFileSync(f, "utf8").matchAll(/useEffect\(\s*\(\)\s*=>(?!\s*\{)/g)].map((m) => `${path.relative(ROOT, f)} @${m.index}`),
    );
    expect(offenders).toEqual([]);
  });
});
