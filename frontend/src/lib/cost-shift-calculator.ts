import type {
  AvgPriceSlot,
  CostBoundedReshapeResult,
  LoadProfileSlots,
  PriceReading,
} from "@/types";
import {
  DATA_MODE_LABELS,
  SLOTS_PER_DAY,
  forwardFillMasked,
  optimizeBoundedReshape,
  type DataMode,
} from "./shift-calculator";
import { supabase } from "./supabase";

// ── Data fetching (price analog of shift-calculator.ts's CO2 fetch path) ───────

/**
 * Loads all day_ahead_prices rows for one region and UTC day, ordered by timestamp.
 * Returns an empty array when the day has not been ingested yet.
 */
export async function fetchDayPrices(
  region: string,
  date: string // ISO date "YYYY-MM-DD"
): Promise<PriceReading[]> {
  const from = `${date}T00:00:00+00:00`;
  const to = `${date}T23:59:59+00:00`;

  const { data, error } = await supabase
    .from("day_ahead_prices")
    .select("*")
    .eq("region", region)
    .gte("timestamp", from)
    .lte("timestamp", to)
    .order("timestamp", { ascending: true });

  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * Loads the average day-ahead price curve for a region over the trailing
 * `windowDays` days (one row per 15-min slot-of-day, UTC) via the
 * avg_price_by_slot() database function.
 */
export async function fetchAveragePrices(
  region: string,
  windowDays: number
): Promise<AvgPriceSlot[]> {
  const { data, error } = await supabase.rpc("avg_price_by_slot", {
    p_region: region,
    p_days: windowDays,
  });

  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * Finds the most recent date a region has any day_ahead_prices for, and
 * loads that full day. Returns null if the region has no data at all.
 */
export async function fetchLatestDayPrices(
  region: string
): Promise<{ date: string; readings: PriceReading[] } | null> {
  const { data, error } = await supabase
    .from("day_ahead_prices")
    .select("timestamp")
    .eq("region", region)
    .order("timestamp", { ascending: false })
    .limit(1);

  if (error) throw new Error(error.message);
  if (!data || data.length === 0) return null;

  const date = (data[0].timestamp as string).slice(0, 10);
  const readings = await fetchDayPrices(region, date);
  return { date, readings };
}

export interface PriceCurve {
  priceSlots: number[]; // per MWh, in `currency`
  currency: string;
  label: string;
  coverageDays: number | null; // null for "latest" (a single day, not a window)
}

/**
 * Resolves a DataMode into one 96-slot day-ahead price curve - the price
 * analog of fetchIntensityCurve(), reusing the same latest/avg30/avg91
 * modes so the cost panel always analyzes the exact period shown in the
 * CO2 chart. Returns null when the region has no matching data.
 */
export async function fetchPriceCurve(
  region: string,
  mode: DataMode
): Promise<PriceCurve | null> {
  const priceSlots = new Array<number>(SLOTS_PER_DAY).fill(0);
  const filled = new Array<boolean>(SLOTS_PER_DAY).fill(false);
  let currency = "EUR";

  if (mode === "latest") {
    const latest = await fetchLatestDayPrices(region);
    if (!latest || latest.readings.length === 0) return null;

    for (const r of latest.readings) {
      const dt = new Date(r.timestamp);
      const slot = (dt.getUTCHours() * 60 + dt.getUTCMinutes()) / 15;
      if (slot >= 0 && slot < SLOTS_PER_DAY) {
        priceSlots[slot] = r.price;
        filled[slot] = true;
        currency = r.currency;
      }
    }
    return {
      priceSlots: forwardFillMasked(priceSlots, filled),
      currency,
      label: `1 day - ${latest.date}`,
      coverageDays: null,
    };
  }

  const windowDays = mode === "avg28" ? 28 : 91;
  const rows = await fetchAveragePrices(region, windowDays);
  if (rows.length === 0) return null;

  for (const r of rows) {
    if (r.slot_index >= 0 && r.slot_index < SLOTS_PER_DAY) {
      priceSlots[r.slot_index] = r.avg_price;
      filled[r.slot_index] = true;
      currency = r.currency;
    }
  }
  return {
    priceSlots: forwardFillMasked(priceSlots, filled),
    currency,
    label: DATA_MODE_LABELS[windowDays === 28 ? "avg28" : "avg91"],
    coverageDays: Math.max(...rows.map((r) => r.days_covered)),
  };
}


// ── Core computation (thin wrapper around shift-calculator.ts's unit-agnostic
// engine - optimizeBoundedReshape just does Σ load × curve, so it's reused
// unchanged against a price curve instead of an intensity curve; results are
// remapped into cost-domain field names below so a cost result can never be
// mistaken for, or merged with, a CO2 result) ─────────────────────────────

/** Price is per MWh; load is in kWh - convert before multiplying. */
function perKwh(priceSlots: number[]): number[] {
  return priceSlots.map((p) => p / 1000);
}

/**
 * Cost-domain equivalent of optimizeBoundedReshape(): the same box-constrained
 * water-filling optimum, solved against the price curve instead of intensity.
 */
export function optimizeBoundedCostReshape(
  loadSlots: LoadProfileSlots,
  priceSlots: number[],
  currency: string,
  maxShiftSlots?: number,
  magnitudeBand?: number
): CostBoundedReshapeResult {
  const result = optimizeBoundedReshape(
    loadSlots,
    perKwh(priceSlots),
    maxShiftSlots,
    magnitudeBand
  );
  return {
    profile: result.profile,
    baselineCost: result.baselineCo2G,
    optimizedCost: result.optimizedCo2G,
    savingsCost: result.savingsG,
    savingsPercent: result.savingsPercent,
    currency,
  };
}
