import type { MemoryItem } from "../types";

type SeedMemory = Pick<MemoryItem, "key" | "value" | "scope" | "source" | "confirmed" | "status">;

const explicit = (scope: string, key: string, value: string): SeedMemory => ({
  scope,
  key,
  value,
  source: "explicit",
  confirmed: true,
  status: "active",
});
const inferred = (scope: string, key: string, value: string, confirmed = false): SeedMemory => ({
  scope,
  key,
  value,
  source: "inferred",
  confirmed,
  status: "active",
});
const forgotten = (scope: string, key: string): SeedMemory => ({
  scope,
  key,
  value: "",
  source: "explicit",
  confirmed: true,
  status: "forgotten",
});

/** 50 seeded memories: a mix of relevant, irrelevant, inferred-unconfirmed and forgotten facts. */
export const SEED_MEMORIES: SeedMemory[] = [
  // global (16)
  explicit("global", "home_area", "Indiranagar"),
  explicit("global", "address", "Flat 4B, Block C, 12th Main, Indiranagar, Bengaluru"),
  explicit("global", "earliest_time", "10:00"),
  explicit("global", "latest_time", "19:00"),
  explicit("global", "pets", "Has a dog; technician should ring before entering"),
  explicit("global", "contact_preference", "WhatsApp updates"),
  explicit("global", "languages", "English or Hindi"),
  explicit("global", "parking", "Visitor parking available at basement B1"),
  inferred("global", "preferred_days", "Weekends"),
  inferred("global", "price_sensitivity", "Usually picks the cheapest option"),
  inferred("global", "prefers_verified_providers", "Only books verified providers", true),
  forgotten("global", "old_home_area"),
  forgotten("global", "office_address"),
  explicit("global", "society_rules", "Society allows contractor entry only 09:00-20:00"),
  explicit("global", "payment_note", "Pays after job completion"),
  inferred("global", "chatty", "Prefers short replies"),

  // plumbing (6)
  explicit("plumbing", "budget_max", "1500"),
  explicit("plumbing", "kitchen_tap", "Jaquar single-lever kitchen mixer"),
  inferred("plumbing", "preferred_provider", "P1 Sharma Plumbing Works", true),
  explicit("plumbing", "water_tank", "Overhead tank on terrace, key with security"),
  inferred("plumbing", "urgency_pattern", "Usually wants same-week visits"),
  forgotten("plumbing", "old_plumber_phone"),

  // electrical (5)
  explicit("electrical", "preferred_provider", "P4 Suresh Electricals"),
  explicit("electrical", "mcb_location", "MCB box behind the main door"),
  explicit("electrical", "budget_max", "1200"),
  inferred("electrical", "inverter", "Has a Luminous inverter in the utility area"),
  forgotten("electrical", "previous_electrician"),

  // ac_servicing (6)
  explicit("ac_servicing", "ac_units", "Two Daikin 1.5 ton split ACs"),
  explicit("ac_servicing", "service_frequency", "Every 6 months"),
  explicit("ac_servicing", "budget_max", "1200"),
  inferred("ac_servicing", "preferred_time", "Saturday mornings"),
  explicit("ac_servicing", "outdoor_unit_access", "Outdoor units on balcony, ladder needed"),
  forgotten("ac_servicing", "preferred_provider"),

  // other services the agent does not handle (17) — must never reach the model for these intents
  explicit("pest_control", "treatment", "Herbal treatment only, kids at home"),
  explicit("pest_control", "frequency", "Quarterly"),
  inferred("pest_control", "provider", "HiCare"),
  explicit("painting", "wall_colour", "Asian Paints Royale, Ivory"),
  explicit("painting", "rooms", "2BHK, ceilings white"),
  forgotten("painting", "budget"),
  explicit("carpentry", "wardrobe", "Sliding wardrobe hinge needs repair"),
  explicit("carpentry", "material", "Prefers plywood over MDF"),
  explicit("cleaning", "deep_clean", "Kitchen deep clean every Diwali"),
  explicit("cleaning", "products", "No bleach-based products"),
  inferred("cleaning", "time", "Sunday afternoons"),
  explicit("appliance_repair", "washing_machine", "LG front-load 7kg"),
  explicit("appliance_repair", "fridge", "Samsung double door, under warranty till 2027"),
  forgotten("appliance_repair", "microwave"),
  explicit("gardening", "plants", "Balcony herbs, watering twice weekly"),
  explicit("gardening", "pots", "Needs 4 large terracotta pots"),
  inferred("gardening", "budget", "Under ₹800"),
];
