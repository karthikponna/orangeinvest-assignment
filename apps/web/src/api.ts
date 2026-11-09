import type { Booking, Fixtures, Health, MemoryItem, OutputMessage, SessionSnapshot, SimState, TraceEvent } from "./types";

const MODEL_STORAGE = "errand.model";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export const modelStore = {
  get: () => localStorage.getItem(MODEL_STORAGE),
  set: (id: string) => localStorage.setItem(MODEL_STORAGE, id),
};

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? "request_failed", body.message);
  return body as T;
}

const post = (url: string, body: unknown = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const api = {
  health: () => fetch("/api/health").then((r) => json<Health>(r)),
  fixtures: () => fetch("/api/fixtures").then((r) => json<Fixtures>(r)),
  createSession: () => post("/api/sessions").then((r) => json<{ session: SessionSnapshot; messages: OutputMessage[] }>(r)),
  trace: (id: string) => fetch(`/api/sessions/${id}/trace`).then((r) => json<{ events: TraceEvent[] }>(r)),
  bookings: () => fetch("/api/bookings").then((r) => json<{ bookings: Booking[] }>(r)),
  memory: (all: boolean) => fetch(`/api/memory${all ? "?all=1" : ""}`).then((r) => json<{ items: MemoryItem[] }>(r)),
  forgetMemory: (id: string, sessionId?: string) => post(`/api/memory/${id}/forget`, { session_id: sessionId }).then((r) => json(r)),
  confirmMemory: (id: string, sessionId?: string) => post(`/api/memory/${id}/confirm`, { session_id: sessionId }).then((r) => json(r)),
  editMemory: (id: string, value: string, sessionId?: string) =>
    fetch(`/api/memory/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value, session_id: sessionId }),
    }).then((r) => json(r)),
  sim: () => fetch("/api/sim").then((r) => json<SimState>(r)),
  forceBook: (outcome: string, sessionId?: string) => post("/api/sim/force-book", { outcome, session_id: sessionId }).then((r) => json<SimState>(r)),
  clearForced: () => fetch("/api/sim/force-book", { method: "DELETE" }).then((r) => json<SimState>(r)),
  priceChange: (providerId: string, pct: number, sessionId?: string) =>
    post("/api/sim/price-change", { provider_id: providerId, pct, session_id: sessionId }).then((r) => json<SimState>(r)),
  providerCancel: (bookingId: string, sessionId?: string) =>
    post("/api/sim/provider-cancel", { booking_id: bookingId, session_id: sessionId }).then((r) => json(r)),
};

export type StreamHandlers = {
  onTrace: (event: TraceEvent) => void;
  onMessage: (msg: OutputMessage) => void;
  onSession: (state: SessionSnapshot) => void;
};

/** POSTs and parses the server-sent event stream from the response body. */
export async function streamSSE(url: string, body: unknown, handlers: StreamHandlers, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) await json(res);

  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length === 0) continue;
      const payload = JSON.parse(data.join("\n"));
      if (event === "trace") handlers.onTrace(payload as TraceEvent);
      else if (event === "message") handlers.onMessage(payload as OutputMessage);
      else if (event === "session") handlers.onSession(payload as SessionSnapshot);
    }
  }
}
