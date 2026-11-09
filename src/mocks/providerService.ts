import { config } from "../config";
import { SERVICES, type Service } from "../types";
import { seededRandom } from "../util/ids";
import { readJson, writeJsonAtomic } from "../util/jsonFile";
import { addDays, dayDiff, isValidDate, isValidDateTime, localNow, nowIso, sleep, slotLabel } from "../util/time";
import { AREAS, OUT_OF_AREA_TRAVEL_FEE, PROVIDERS, SEED_BOOKINGS, SLOT_HOURS, findProvider } from "./data";
import { ToolError } from "./errors";

/**
 * Local mock of the external provider platform. It behaves like a remote service:
 * its state is persisted to disk so holds/bookings survive a process restart.
 */

export type ForcedBookOutcome = "success" | "slot_taken" | "timeout_booked" | "timeout_not_booked";

export interface MockHold {
  hold_id: string;
  provider_id: string;
  service: Service;
  slot: string; // YYYY-MM-DDTHH:mm
  quoted_price: number;
  search_price: number;
  created_at: string;
  expires_at: string;
  consumed_by_key?: string;
  released?: boolean;
}

export type MockBookingStatus = "confirmed" | "completed" | "cancelled" | "cancelled_by_provider";

export interface MockBooking {
  booking_id: string;
  user_id: string;
  provider_id: string;
  service: Service;
  slot: string;
  price: number;
  status: MockBookingStatus;
  hold_id?: string;
  created_at: string;
  updated_at: string;
}

interface IdempotencyRecord {
  op: "book" | "cancel" | "reschedule";
  status: "booked" | "not_booked" | "done";
  booking_id?: string;
  reason?: string;
  at: string;
}

export interface ProviderEvent {
  id: string;
  type: "provider_cancelled";
  user_id: string;
  booking_id: string;
  provider_id: string;
  at: string;
  delivered: boolean;
}

interface MockState {
  initialized_at: string;
  counters: { hold: number; booking: number; event: number };
  holds: Record<string, MockHold>;
  bookings: Record<string, MockBooking>;
  idempotency: Record<string, IdempotencyRecord>;
  book_attempts: Record<string, number>;
  call_counts: Record<string, number>;
  events: ProviderEvent[];
  forced_book_outcomes: ForcedBookOutcome[];
  price_change_on_hold: Record<string, number>;
}

const SLOT_SEP = "@";

export function makeSlotId(service: string, dateTime: string) {
  return `${service}${SLOT_SEP}${dateTime}`;
}

export function parseSlotId(slot: string, fallbackService?: string): { service?: string; dateTime: string } {
  const raw = String(slot ?? "").trim();
  const idx = raw.indexOf(SLOT_SEP);
  if (idx === -1) return { service: fallbackService, dateTime: raw };
  return { service: raw.slice(0, idx), dateTime: raw.slice(idx + 1) };
}

function normaliseService(service: unknown): Service {
  const s = String(service ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, Service> = {
    plumber: "plumbing",
    electrician: "electrical",
    electric: "electrical",
    ac: "ac_servicing",
    ac_service: "ac_servicing",
    ac_repair: "ac_servicing",
    air_conditioner: "ac_servicing",
  };
  const resolved = (SERVICES as readonly string[]).includes(s) ? (s as Service) : aliases[s];
  if (!resolved) {
    throw new ToolError("invalid_input", `Unsupported service "${service}". Supported: ${SERVICES.join(", ")}.`, false, {
      supported_services: [...SERVICES],
    });
  }
  return resolved;
}

const roundTo10 = (n: number) => Math.round(n / 10) * 10;

export class MockProviderService {
  private state: MockState;

  constructor(
    private readonly file = config.paths.mockStateFile,
    private readonly defaultUserId = config.userId,
    private readonly seed = config.mock.seed,
  ) {
    this.state = readJson<MockState | null>(this.file, null) ?? this.initialState();
    this.persist();
  }

  private initialState(): MockState {
    const today = localNow().date;
    const state: MockState = {
      initialized_at: nowIso(),
      counters: { hold: 0, booking: 1000, event: 0 },
      holds: {},
      bookings: {},
      idempotency: {},
      book_attempts: {},
      call_counts: {},
      events: [],
      forced_book_outcomes: [],
      price_change_on_hold: { ...config.mock.priceChangeOnHold },
    };
    for (const seed of SEED_BOOKINGS) {
      state.counters.booking += 1;
      const id = `B-${state.counters.booking}`;
      state.bookings[id] = {
        booking_id: id,
        user_id: this.defaultUserId,
        provider_id: seed.provider_id,
        service: seed.service,
        slot: `${addDays(today, seed.day_offset)}T${seed.time}`,
        price: seed.price,
        status: seed.status,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
    }
    return state;
  }

  private persist() {
    writeJsonAtomic(this.file, this.state);
  }

  private async latency() {
    if (config.mock.latencyMs > 0) await sleep(config.mock.latencyMs);
  }

  private isGeneratedFree(providerId: string, dateTime: string) {
    return seededRandom(this.seed, "slot", providerId, dateTime) < 0.6;
  }

  private isActiveHold(h: MockHold) {
    return !h.consumed_by_key && !h.released && Date.parse(h.expires_at) > Date.now();
  }

  private isSlotFree(providerId: string, dateTime: string, ignoreBookingId?: string) {
    if (!SLOT_HOURS.includes(dateTime.split("T")[1] ?? "")) return false;
    if (dateTime <= localNow().stamp) return false;
    if (!this.isGeneratedFree(providerId, dateTime)) return false;
    const booked = Object.values(this.state.bookings).some(
      (b) => b.provider_id === providerId && b.slot === dateTime && b.status === "confirmed" && b.booking_id !== ignoreBookingId,
    );
    if (booked) return false;
    return !Object.values(this.state.holds).some(
      (h) => h.provider_id === providerId && h.slot === dateTime && this.isActiveHold(h),
    );
  }

  private publicBooking(b: MockBooking) {
    const provider = findProvider(b.provider_id);
    return {
      booking_id: b.booking_id,
      provider_id: b.provider_id,
      provider_name: provider?.name ?? b.provider_id,
      service: b.service,
      slot: b.slot,
      slot_label: slotLabel(b.slot),
      price: b.price,
      status: b.status,
      when: b.slot > localNow().stamp ? "upcoming" : "past",
    };
  }

  // ───────────────────────── Tool contracts ─────────────────────────

  async search_providers(input: { service: string; area: string; date_range?: { from?: string; to?: string } }) {
    await this.latency();
    const service = normaliseService(input.service);
    const area = String(input.area ?? "").trim();
    if (!area) throw new ToolError("invalid_input", "area is required");

    const today = localNow().date;
    let from = isValidDate(input.date_range?.from) ? input.date_range!.from! : today;
    let to = isValidDate(input.date_range?.to) ? input.date_range!.to! : addDays(from, 6);
    if (from < today) from = today;
    if (to < from) to = from;
    if (dayDiff(from, to) > 13) to = addDays(from, 13);

    const knownArea = AREAS.find((a) => a.toLowerCase() === area.toLowerCase());
    const providers = PROVIDERS.filter((p) => p.services[service] !== undefined)
      .map((p) => {
        const servesArea = !!knownArea && p.areas.includes(knownArea);
        const slots: Array<{ slot: string; label: string }> = [];
        for (let d = 0; d <= dayDiff(from, to) && slots.length < 12; d++) {
          const date = addDays(from, d);
          for (const hour of SLOT_HOURS) {
            const dt = `${date}T${hour}`;
            if (this.isSlotFree(p.id, dt)) slots.push({ slot: makeSlotId(service, dt), label: slotLabel(dt) });
            if (slots.length >= 12) break;
          }
        }
        return {
          provider_id: p.id,
          name: p.name,
          service,
          price: p.services[service]!,
          rating: p.rating,
          reviews_count: p.reviews_count,
          serves_area: servesArea,
          travel_fee: servesArea ? 0 : OUT_OF_AREA_TRAVEL_FEE,
          experience_years: p.experience_years,
          attributes: p.attributes,
          available_slots: slots,
        };
      })
      .sort((a, b) => Number(b.serves_area) - Number(a.serves_area) || b.rating - a.rating)
      .slice(0, 8);

    return { service, area: knownArea ?? area, date_range: { from, to }, count: providers.length, providers };
  }

  async get_provider(input: { provider_id: string }) {
    await this.latency();
    const p = findProvider(input.provider_id);
    if (!p) throw new ToolError("not_found", `Provider ${input.provider_id} not found`);
    return {
      provider_id: p.id,
      name: p.name,
      about: p.about,
      services: p.services,
      rating: p.rating,
      reviews_count: p.reviews_count,
      areas: p.areas,
      experience_years: p.experience_years,
      languages: p.languages,
      attributes: p.attributes,
      reviews: p.reviews,
    };
  }

  async hold_slot(input: { provider_id: string; slot: string }) {
    await this.latency();
    const p = findProvider(input.provider_id);
    if (!p) throw new ToolError("not_found", `Provider ${input.provider_id} not found`);
    const parsed = parseSlotId(input.slot, Object.keys(p.services)[0]);
    const service = normaliseService(parsed.service);
    const searchPrice = p.services[service];
    if (searchPrice === undefined) {
      throw new ToolError("invalid_input", `${p.name} does not offer ${service}`);
    }
    if (!isValidDateTime(parsed.dateTime)) {
      throw new ToolError("invalid_input", `slot must look like "${makeSlotId(service, "YYYY-MM-DDTHH:mm")}"`);
    }
    if (!this.isSlotFree(p.id, parsed.dateTime)) {
      throw new ToolError("slot_unavailable", `${slotLabel(parsed.dateTime)} is not available for ${p.name}`);
    }

    const pct = this.state.price_change_on_hold[p.id] ?? 0;
    const quoted = pct ? roundTo10(searchPrice * (1 + pct)) : searchPrice;
    this.state.counters.hold += 1;
    const hold: MockHold = {
      hold_id: `H-${String(this.state.counters.hold).padStart(4, "0")}`,
      provider_id: p.id,
      service,
      slot: parsed.dateTime,
      quoted_price: quoted,
      search_price: searchPrice,
      created_at: nowIso(),
      expires_at: new Date(Date.now() + config.mock.holdTtlMs).toISOString(),
    };
    this.state.holds[hold.hold_id] = hold;
    this.persist();
    return {
      hold_id: hold.hold_id,
      provider_id: p.id,
      provider_name: p.name,
      service,
      slot: hold.slot,
      slot_label: slotLabel(hold.slot),
      quoted_price: quoted,
      search_price: searchPrice,
      price_changed: quoted !== searchPrice,
      expires_at: hold.expires_at,
    };
  }

  async book(input: { hold_id: string; idempotency_key: string }) {
    await this.latency();
    const key = String(input.idempotency_key ?? "").trim();
    if (!key) throw new ToolError("invalid_input", "idempotency_key is required");

    const previous = this.state.idempotency[key];
    if (previous?.op === "book" && previous.status === "booked" && previous.booking_id) {
      return { ...this.publicBooking(this.state.bookings[previous.booking_id]!), idempotent_replay: true };
    }

    const hold = this.state.holds[input.hold_id];
    if (!hold) throw new ToolError("not_found", `Hold ${input.hold_id} not found`);
    if (hold.consumed_by_key && hold.consumed_by_key !== key) {
      throw new ToolError("hold_already_used", `Hold ${hold.hold_id} was already used for another booking`);
    }
    if (hold.released || Date.parse(hold.expires_at) <= Date.now()) {
      throw new ToolError("hold_expired", `Hold ${hold.hold_id} expired at ${hold.expires_at}`);
    }

    const attempt = (this.state.book_attempts[key] = (this.state.book_attempts[key] ?? 0) + 1);
    const forced = this.state.forced_book_outcomes.shift();
    let outcome: ForcedBookOutcome;
    if (forced) {
      outcome = forced;
    } else {
      const { success, slotTaken } = config.mock.bookOutcomeRates;
      const r = seededRandom(this.seed, "book", key, attempt);
      if (r < success) outcome = "success";
      else if (r < success + slotTaken) outcome = "slot_taken";
      else {
        const booked = seededRandom(this.seed, "timeout", key, attempt) < config.mock.timeoutBookedFraction;
        outcome = booked ? "timeout_booked" : "timeout_not_booked";
      }
    }

    if (outcome === "slot_taken") {
      hold.released = true;
      this.state.idempotency[key] = { op: "book", status: "not_booked", reason: "slot_taken", at: nowIso() };
      this.persist();
      throw new ToolError("slot_taken", `${slotLabel(hold.slot)} was taken by another customer`);
    }

    if (outcome === "success" || outcome === "timeout_booked") {
      this.state.counters.booking += 1;
      const booking: MockBooking = {
        booking_id: `B-${this.state.counters.booking}`,
        user_id: this.defaultUserId,
        provider_id: hold.provider_id,
        service: hold.service,
        slot: hold.slot,
        price: hold.quoted_price,
        status: "confirmed",
        hold_id: hold.hold_id,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      this.state.bookings[booking.booking_id] = booking;
      hold.consumed_by_key = key;
      this.state.idempotency[key] = { op: "book", status: "booked", booking_id: booking.booking_id, at: nowIso() };
    } else {
      this.state.idempotency[key] = { op: "book", status: "not_booked", reason: "timeout", at: nowIso() };
    }
    this.persist();

    if (outcome === "success") {
      return { ...this.publicBooking(this.state.bookings[this.state.idempotency[key]!.booking_id!]!), idempotent_replay: false };
    }
    await sleep(config.mock.timeoutDelayMs);
    throw new ToolError("timeout", `book timed out after ${config.mock.timeoutDelayMs}ms; outcome unknown`, true);
  }

  async get_booking_status(input: { hold_id?: string; idempotency_key?: string }) {
    await this.latency();
    if (input.idempotency_key) {
      const rec = this.state.idempotency[input.idempotency_key];
      if (!rec) return { status: "not_found" as const, idempotency_key: input.idempotency_key };
      if (rec.status === "booked" && rec.booking_id) {
        const b = this.state.bookings[rec.booking_id]!;
        return { status: b.status, booking: this.publicBooking(b) };
      }
      return { status: "not_booked" as const, reason: rec.reason ?? null };
    }
    if (input.hold_id) {
      const booking = Object.values(this.state.bookings).find((b) => b.hold_id === input.hold_id);
      if (booking) return { status: booking.status, booking: this.publicBooking(booking) };
      const hold = this.state.holds[input.hold_id];
      if (!hold) return { status: "not_found" as const, hold_id: input.hold_id };
      return {
        status: "not_booked" as const,
        hold_status: this.isActiveHold(hold) ? "active" : hold.released ? "released" : "expired",
        expires_at: hold.expires_at,
      };
    }
    throw new ToolError("invalid_input", "Provide hold_id or idempotency_key");
  }

  async cancel(input: { booking_id: string; idempotency_key: string }) {
    await this.latency();
    const key = String(input.idempotency_key ?? "").trim();
    if (!key) throw new ToolError("invalid_input", "idempotency_key is required");
    const previous = this.state.idempotency[key];
    if (previous?.op === "cancel" && previous.status === "done") {
      return { status: "cancelled" as const, idempotent_replay: true, booking_id: previous.booking_id };
    }

    const calls = (this.state.call_counts[`cancel:${key}`] = (this.state.call_counts[`cancel:${key}`] ?? 0) + 1);
    this.persist();
    if (calls === 1) throw new ToolError("service_unavailable", "503 Service Unavailable (transient)", true);

    const b = this.state.bookings[input.booking_id];
    if (!b) throw new ToolError("not_found", `Booking ${input.booking_id} not found`);
    if (b.status !== "confirmed") {
      throw new ToolError("invalid_state", `Booking ${b.booking_id} is ${b.status} and cannot be cancelled`);
    }
    b.status = "cancelled";
    b.updated_at = nowIso();
    this.state.idempotency[key] = { op: "cancel", status: "done", booking_id: b.booking_id, at: nowIso() };
    this.persist();
    return { status: "cancelled" as const, idempotent_replay: false, booking: this.publicBooking(b) };
  }

  async reschedule(input: { booking_id: string; slot: string; idempotency_key: string }) {
    await this.latency();
    const key = String(input.idempotency_key ?? "").trim();
    if (!key) throw new ToolError("invalid_input", "idempotency_key is required");
    const previous = this.state.idempotency[key];
    if (previous?.op === "reschedule" && previous.status === "done" && previous.booking_id) {
      return { status: "rescheduled" as const, idempotent_replay: true, booking: this.publicBooking(this.state.bookings[previous.booking_id]!) };
    }

    const b = this.state.bookings[input.booking_id];
    if (!b) throw new ToolError("not_found", `Booking ${input.booking_id} not found`);
    if (b.status !== "confirmed") {
      throw new ToolError("invalid_state", `Booking ${b.booking_id} is ${b.status} and cannot be rescheduled`);
    }
    const { dateTime } = parseSlotId(input.slot, b.service);
    if (!isValidDateTime(dateTime)) throw new ToolError("invalid_input", "slot must look like YYYY-MM-DDTHH:mm");
    const time = dateTime.split("T")[1]!;
    if (config.mock.rescheduleConflictTimes.includes(time) || !this.isSlotFree(b.provider_id, dateTime, b.booking_id)) {
      throw new ToolError("slot_conflict", `${slotLabel(dateTime)} conflicts with the provider's schedule`);
    }
    b.slot = dateTime;
    b.updated_at = nowIso();
    this.state.idempotency[key] = { op: "reschedule", status: "done", booking_id: b.booking_id, at: nowIso() };
    this.persist();
    return { status: "rescheduled" as const, idempotent_replay: false, booking: this.publicBooking(b) };
  }

  async list_bookings(input: { user_id: string }) {
    await this.latency();
    const bookings = Object.values(this.state.bookings)
      .filter((b) => b.user_id === input.user_id)
      .sort((a, b) => a.slot.localeCompare(b.slot))
      .map((b) => this.publicBooking(b));
    return { user_id: input.user_id, count: bookings.length, bookings };
  }

  // ─────────────── Internal reads + simulation controls (not LLM tools) ───────────────

  peekHold(holdId: string) {
    const h = this.state.holds[holdId];
    if (!h) return undefined;
    return { ...h, active: this.isActiveHold(h), provider_name: findProvider(h.provider_id)?.name ?? h.provider_id };
  }

  getBooking(bookingId: string) {
    const b = this.state.bookings[bookingId];
    return b ? { ...this.publicBooking(b), user_id: b.user_id } : undefined;
  }

  /** Simulates the 10-minute hold running out. */
  expireHold(holdId: string) {
    const h = this.state.holds[holdId];
    if (!h) throw new ToolError("not_found", `Hold ${holdId} not found`);
    h.expires_at = new Date(Date.now() - 1000).toISOString();
    this.persist();
  }

  /** Raw booking records, including the hold each booking came from. */
  allBookings(): MockBooking[] {
    return Object.values(this.state.bookings).map((b) => ({ ...b }));
  }

  simulationState() {
    return {
      queued_book_outcomes: [...this.state.forced_book_outcomes],
      price_change_on_hold: { ...this.state.price_change_on_hold },
    };
  }

  clearForcedBookOutcomes() {
    this.state.forced_book_outcomes = [];
    this.persist();
  }

  forceNextBookOutcome(outcome: ForcedBookOutcome) {
    this.state.forced_book_outcomes.push(outcome);
    this.persist();
  }

  setPriceChangeOnHold(providerId: string, pct: number) {
    if (pct) this.state.price_change_on_hold[providerId] = pct;
    else delete this.state.price_change_on_hold[providerId];
    this.persist();
  }

  simulateProviderCancel(bookingId: string): ProviderEvent {
    const b = this.state.bookings[bookingId];
    if (!b) throw new ToolError("not_found", `Booking ${bookingId} not found`);
    if (b.status !== "confirmed") throw new ToolError("invalid_state", `Booking ${bookingId} is ${b.status}`);
    b.status = "cancelled_by_provider";
    b.updated_at = nowIso();
    this.state.counters.event += 1;
    const event: ProviderEvent = {
      id: `EV-${this.state.counters.event}`,
      type: "provider_cancelled",
      user_id: b.user_id,
      booking_id: b.booking_id,
      provider_id: b.provider_id,
      at: nowIso(),
      delivered: false,
    };
    this.state.events.push(event);
    this.persist();
    return event;
  }

  /** Poll-style event feed: returns undelivered events and marks them delivered. */
  drainEvents(userId: string): ProviderEvent[] {
    const pending = this.state.events.filter((e) => e.user_id === userId && !e.delivered);
    if (!pending.length) return [];
    for (const e of pending) e.delivered = true;
    this.persist();
    return pending;
  }
}
