import type {
  AvgGenerationMixSlot,
  AvgIntensitySlot,
  BoundedReshapeResult,
  Co2Reading,
  LoadProfileSlots,
} from "@/types";
import { fetchEmissionFactors } from "./emission-factors";
import { supabase } from "./supabase";

export const SLOTS_PER_DAY = 96; // 24 h × 4

// ── Shared chart slot labels ────────────────────────────────────────────────────
// Every 96-slot chart in the app uses these two - slotLabel for tooltips (needs
// to be unique/exact per slot) and hourTickLabel for axis ticks (deliberately
// sparse, blank except on the hour, to avoid a cluttered x-axis). Charts must
// key their XAxis dataKey on the numeric slot index, never on hourTickLabel's
// output - many slots share the same blank string, and Recharts can't build an
// unambiguous category scale from a dataKey with duplicate values, which breaks
// hover/tooltip resolution (it silently snaps to the first matching row instead
// of the actually-hovered one).

/** Slot index → exact "HH:MM" start-of-slot label (0 → "00:00", 95 → "23:45"). */
export function slotLabel(i: number): string {
  const h = Math.floor(i / 4);
  const m = (i % 4) * 15;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Slot index → "HH:00" on the hour, blank otherwise - for sparse axis ticks only. */
export function hourTickLabel(i: number): string {
  return i % 4 === 0 ? `${String(Math.floor(i / 4)).padStart(2, "0")}:00` : "";
}

// ── Data fetching ──────────────────────────────────────────────────────────────

/**
 * Loads all co2_readings rows for one region and UTC day, ordered by timestamp.
 * Returns an empty array when the day has not been ingested yet.
 */
export async function fetchDayIntensity(
  region: string,
  date: string // ISO date "YYYY-MM-DD"
): Promise<Co2Reading[]> {
  const from = `${date}T00:00:00+00:00`;
  const to = `${date}T23:59:59+00:00`;

  const { data, error } = await supabase
    .from("co2_readings")
    .select("*")
    .eq("region", region)
    .gte("timestamp", from)
    .lte("timestamp", to)
    .order("timestamp", { ascending: true });

  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * Loads the average intensity curve for a region over the trailing
 * `windowDays` days (one row per 15-min slot-of-day, UTC) via the
 * avg_intensity_by_slot() database function.
 * Returns an empty array when no history has been ingested yet.
 */
export async function fetchAverageIntensity(
  region: string,
  windowDays: number
): Promise<AvgIntensitySlot[]> {
  const { data, error } = await supabase.rpc("avg_intensity_by_slot", {
    p_region: region,
    p_days: windowDays,
  });

  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Returns the ISO date ("YYYY-MM-DD") n UTC days before the given one. */
export function daysBeforeIsoDate(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Returns the ISO date ("YYYY-MM-DD") one UTC day before the given one. */
export function priorIsoDate(date: string): string {
  return daysBeforeIsoDate(date, 1);
}

/**
 * Finds the most recent date a region has any co2_readings for, and loads
 * that full day. Returns null if the region has no data at all. The
 * resolved date is returned alongside the readings since "latest" is
 * otherwise opaque to the caller (ingestion can lag, so it isn't always
 * yesterday). If the most recent date is still a partial day (e.g. today,
 * before the rest of its slots have been published/ingested), falls back
 * to the prior day so "1 day" never shows a half-populated curve.
 */
export async function fetchLatestDayIntensity(
  region: string
): Promise<{ date: string; readings: Co2Reading[] } | null> {
  const { data, error } = await supabase
    .from("co2_readings")
    .select("timestamp")
    .eq("region", region)
    .order("timestamp", { ascending: false })
    .limit(1);

  if (error) throw new Error(error.message);
  if (!data || data.length === 0) return null;

  const date = (data[0].timestamp as string).slice(0, 10); // stored as UTC timestamptz
  const readings = await fetchDayIntensity(region, date);

  if (readings.length < SLOTS_PER_DAY) {
    const priorDate = priorIsoDate(date);
    const priorReadings = await fetchDayIntensity(region, priorDate);
    if (priorReadings.length > 0) {
      return { date: priorDate, readings: priorReadings };
    }
  }

  return { date, readings };
}

// ── Shared time-period selection (Co2Chart + ShiftCalculator) ──────────────────

export type DataMode = "latest" | "avg28" | "avg91";

/** Shared select labels - Co2Chart and ShiftCalculator both read from here
 * so the two never drift apart on wording. */
export const DATA_MODE_LABELS: Record<DataMode, string> = {
  latest: "1 day",
  avg28: "4 weeks (28 days)",
  avg91: "3 months (91 days)",
};

/** DataMode keys, in display order - shared by every "Time period" select. */
export const DATA_MODE_IDS = Object.keys(DATA_MODE_LABELS) as DataMode[];

export interface IntensityCurve {
  intensitySlots: number[];
  renewableSlots: (number | null)[];
  label: string;
  coverageDays: number | null; // null for "latest" (a single day, not a window)
  windowEndDate: string | null; // null for "latest" (already dated in `label`)
}

/**
 * Resolves a DataMode into one 96-slot intensity curve - the single fetch
 * path shared by Co2Chart and ShiftCalculator so the two can never disagree
 * about what "the current period" actually contains. Returns null when the
 * region has no matching data.
 */
export async function fetchIntensityCurve(
  region: string,
  mode: DataMode
): Promise<IntensityCurve | null> {
  const intensitySlots = new Array<number>(SLOTS_PER_DAY).fill(0);
  const renewableSlots = new Array<number | null>(SLOTS_PER_DAY).fill(null);

  if (mode === "latest") {
    const latest = await fetchLatestDayIntensity(region);
    if (!latest || latest.readings.length === 0) return null;

    for (const r of latest.readings) {
      const dt = new Date(r.timestamp);
      const slot = (dt.getUTCHours() * 60 + dt.getUTCMinutes()) / 15;
      if (slot >= 0 && slot < SLOTS_PER_DAY) {
        intensitySlots[slot] = r.intensity_gco2_kwh;
        renewableSlots[slot] = r.renewable_percentage;
      }
    }
    return {
      intensitySlots: forwardFill(intensitySlots),
      renewableSlots,
      label: `1 day - ${latest.date}`,
      coverageDays: null,
      windowEndDate: null,
    };
  }

  const windowDays = mode === "avg28" ? 28 : 91;
  const rows = await fetchAverageIntensity(region, windowDays);
  if (rows.length === 0) return null;

  for (const r of rows) {
    if (r.slot_index >= 0 && r.slot_index < SLOTS_PER_DAY) {
      intensitySlots[r.slot_index] = r.avg_intensity_gco2_kwh;
      renewableSlots[r.slot_index] = r.avg_renewable_percentage;
    }
  }
  return {
    intensitySlots: forwardFill(intensitySlots),
    renewableSlots,
    label: DATA_MODE_LABELS[windowDays === 28 ? "avg28" : "avg91"],
    coverageDays: Math.max(...rows.map((r) => r.days_covered)),
    windowEndDate: rows[0].window_end_date,
  };
}

/**
 * Loads the average renewable/nuclear/fossil generation-mix curve for a
 * region over the trailing `windowDays` days via the
 * avg_generation_mix_by_slot() database function.
 */
export async function fetchAverageGenerationMix(
  region: string,
  windowDays: number
): Promise<AvgGenerationMixSlot[]> {
  const { data, error } = await supabase.rpc("avg_generation_mix_by_slot", {
    p_region: region,
    p_days: windowDays,
  });

  if (error) throw new Error(error.message);
  return data ?? [];
}

export interface GenerationMixCurve {
  renewableSlots: number[];
  nuclearSlots: number[];
  fossilSlots: number[];
  label: string;
  coverageDays: number | null;
}

/**
 * Resolves a DataMode into a 96-slot renewable/nuclear/fossil breakdown for
 * the Step 2 stacked chart. "latest" categorizes each reading's raw
 * generation_mix client-side (each source's bucket comes from
 * emission_factors); avg28/avg91 do the same categorization in SQL over the
 * whole window via avg_generation_mix_by_slot(). Only ENTSO-E-sourced
 * readings carry generation_mix, so regions without ENTSO-E history return
 * null here even if they have plain intensity data.
 */
export async function fetchGenerationMixCurve(
  region: string,
  mode: DataMode
): Promise<GenerationMixCurve | null> {
  const renewableSlots = new Array<number>(SLOTS_PER_DAY).fill(0);
  const nuclearSlots = new Array<number>(SLOTS_PER_DAY).fill(0);
  const fossilSlots = new Array<number>(SLOTS_PER_DAY).fill(0);
  const filled = new Array<boolean>(SLOTS_PER_DAY).fill(false);

  if (mode === "latest") {
    const latest = await fetchLatestDayIntensity(region);
    if (!latest || latest.readings.length === 0) return null;

    const factors = await fetchEmissionFactors();
    const bucketBySource = new Map<string, "renewable" | "nuclear" | "fossil">();
    for (const f of factors) {
      bucketBySource.set(
        f.source_name,
        f.source_name === "nuclear" ? "nuclear" : f.is_renewable ? "renewable" : "fossil"
      );
    }

    for (const r of latest.readings) {
      if (!r.generation_mix) continue;
      const dt = new Date(r.timestamp);
      const slot = (dt.getUTCHours() * 60 + dt.getUTCMinutes()) / 15;
      if (slot < 0 || slot >= SLOTS_PER_DAY) continue;
      filled[slot] = true;
      for (const [source, pct] of Object.entries(r.generation_mix)) {
        const bucket = bucketBySource.get(source) ?? "fossil";
        if (bucket === "renewable") renewableSlots[slot] += pct;
        else if (bucket === "nuclear") nuclearSlots[slot] += pct;
        else fossilSlots[slot] += pct;
      }
    }
    if (!filled.some(Boolean)) return null;
    return {
      renewableSlots: forwardFillMasked(renewableSlots, filled),
      nuclearSlots: forwardFillMasked(nuclearSlots, filled),
      fossilSlots: forwardFillMasked(fossilSlots, filled),
      label: DATA_MODE_LABELS.latest,
      coverageDays: null,
    };
  }

  const windowDays = mode === "avg28" ? 28 : 91;
  const rows = await fetchAverageGenerationMix(region, windowDays);
  if (rows.length === 0) return null;

  for (const r of rows) {
    if (r.slot_index >= 0 && r.slot_index < SLOTS_PER_DAY) {
      renewableSlots[r.slot_index] = r.avg_renewable_percentage;
      nuclearSlots[r.slot_index] = r.avg_nuclear_percentage;
      fossilSlots[r.slot_index] = r.avg_fossil_percentage;
      filled[r.slot_index] = true;
    }
  }
  return {
    renewableSlots: forwardFillMasked(renewableSlots, filled),
    nuclearSlots: forwardFillMasked(nuclearSlots, filled),
    fossilSlots: forwardFillMasked(fossilSlots, filled),
    label: DATA_MODE_LABELS[windowDays === 28 ? "avg28" : "avg91"],
    coverageDays: Math.max(...rows.map((r) => r.days_covered)),
  };
}

// ── Core computation ───────────────────────────────────────────────────────────

/** Fills empty (0) slots with the nearest previous value, in place. */
function forwardFill(arr: number[]): number[] {
  let last = arr.find((v) => v > 0) ?? 0;
  for (let i = 0; i < SLOTS_PER_DAY; i++) {
    if (arr[i] > 0) last = arr[i];
    else arr[i] = last;
  }
  return arr;
}

/**
 * Fills unwritten slots with the nearest previous written value, in place.
 * Uses an explicit `filled` mask rather than "value > 0 means present"
 * (unlike forwardFill() above) - correct wherever 0 is a legitimate value,
 * like a generation-mix bucket's share when the grid ran on none of it, or
 * a negative day-ahead price during oversupply.
 */
export function forwardFillMasked(arr: number[], filled: boolean[]): number[] {
  const firstFilledIdx = filled.findIndex(Boolean);
  let last = firstFilledIdx >= 0 ? arr[firstFilledIdx] : 0;
  for (let i = 0; i < SLOTS_PER_DAY; i++) {
    if (filled[i]) last = arr[i];
    else arr[i] = last;
  }
  return arr;
}

/**
 * Computes total CO2 (grams) for a given circular shift of the load profile
 * against the intensity array.
 *
 * shift = 0 → no shift (baseline)
 * shift = 4 → production shifted 1 h later
 * shift = -4 → production shifted 1 h earlier
 *
 * The load profile wraps around midnight (circular shift).
 */
export function computeCo2ForShift(
  loadSlots: LoadProfileSlots,
  intensitySlots: number[],
  shiftSlots: number
): number {
  let total = 0;
  for (let i = 0; i < SLOTS_PER_DAY; i++) {
    // Which intensity slot does this load slot land on after shifting?
    const intensityIdx =
      ((i + shiftSlots) % SLOTS_PER_DAY + SLOTS_PER_DAY) % SLOTS_PER_DAY;
    total += loadSlots[i] * intensitySlots[intensityIdx];
  }
  return total;
}

// ── Bounded local reshaping ──────────────────────────────────────────────────

const RESHAPE_MAX_SHIFT_SLOTS = 4; // default ±60 minutes
const RESHAPE_MAGNITUDE_BAND = 0.2; // default ±20% of each slot's (shifted) original value

/** Rotates a load profile by shiftSlots - the array form of computeCo2ForShift's rotation. */
export function rotateProfile(loadSlots: LoadProfileSlots, shiftSlots: number): number[] {
  return Array.from(
    { length: SLOTS_PER_DAY },
    (_, j) => loadSlots[((j - shiftSlots) % SLOTS_PER_DAY + SLOTS_PER_DAY) % SLOTS_PER_DAY]
  );
}

/**
 * Water-fills one already-shifted profile against intensity: per-slot
 * [lower, upper] bounds are derived from `shiftedProfile`, then the fixed
 * total is distributed cheapest-intensity-slot-first up to each slot's
 * upper bound - the exact optimum for a linear cost under box constraints
 * plus one equality constraint (a fractional-knapsack argument), not a
 * heuristic, for this one fixed shift.
 */
function waterFillReshape(
  shiftedProfile: number[],
  intensitySlots: number[],
  maxLoad: number,
  minNonZeroLoad: number,
  magnitudeBand: number
): { profile: number[]; cost: number } {
  const lower = shiftedProfile.map((v) =>
    v > 0 ? Math.max(v * (1 - magnitudeBand), minNonZeroLoad) : 0
  );
  const upper = shiftedProfile.map((v) =>
    v > 0 ? Math.min(v * (1 + magnitudeBand), maxLoad) : 0
  );

  const total = shiftedProfile.reduce((s, v) => s + v, 0);
  const lowerSum = lower.reduce((s, v) => s + v, 0);
  let remaining = total - lowerSum;

  const profile = [...lower];
  const cheapestFirst = Array.from({ length: SLOTS_PER_DAY }, (_, j) => j).sort(
    (a, b) => intensitySlots[a] - intensitySlots[b]
  );
  for (const j of cheapestFirst) {
    if (remaining <= 1e-9) break;
    const headroom = upper[j] - lower[j];
    const take = Math.min(headroom, remaining);
    profile[j] += take;
    remaining -= take;
  }

  return { profile, cost: computeCo2ForShift(profile, intensitySlots, 0) };
}

/**
 * Optimizes a load profile against an intensity curve under tight bounds:
 * each slot may move by at most `maxShiftSlots` and its value may change by
 * at most `magnitudeBand` of its (shifted) original - never above the
 * profile's historical peak, never below its lowest non-zero value - with
 * total daily energy conserved exactly (load is relocated, not created or
 * removed). At `magnitudeBand = 0` this degenerates to a pure rigid shift.
 *
 * Jointly exact solve: for every candidate shift within ±maxShiftSlots, the
 * per-slot bounds it implies are water-filled to the exact optimum (see
 * waterFillReshape), and shifts are compared on that POST-reshape cost, not
 * the pre-reshape rigid-shift cost - a shift that looks worse unshifted can
 * still unlock a cheaper reshape once resizing is allowed, so scoring only
 * the final reshaped cost per shift is what makes the search jointly exact.
 * At most ~17 water-fill passes total (one per candidate shift, for the
 * largest shift-window option) - cheap enough to always do the full search.
 */
export function optimizeBoundedReshape(
  loadSlots: LoadProfileSlots,
  intensitySlots: number[],
  maxShiftSlots: number = RESHAPE_MAX_SHIFT_SLOTS,
  magnitudeBand: number = RESHAPE_MAGNITUDE_BAND
): BoundedReshapeResult {
  const baselineCo2G = computeCo2ForShift(loadSlots, intensitySlots, 0);

  const maxLoad = Math.max(...loadSlots);
  const nonZero = loadSlots.filter((v) => v > 0);
  const minNonZeroLoad = nonZero.length > 0 ? Math.min(...nonZero) : 0;

  let bestShift = 0;
  let bestProfile = loadSlots.slice();
  let bestCost = Infinity;

  for (let s = -maxShiftSlots; s <= maxShiftSlots; s++) {
    const { profile: candidate, cost } = waterFillReshape(
      rotateProfile(loadSlots, s),
      intensitySlots,
      maxLoad,
      minNonZeroLoad,
      magnitudeBand
    );
    if (cost < bestCost) {
      bestCost = cost;
      bestShift = s;
      bestProfile = candidate;
    }
  }

  const optimizedCo2G = bestCost;
  const savingsG = baselineCo2G - optimizedCo2G;

  const magnitudePercents: (number | null)[] = loadSlots.map((v, i) => {
    if (v === 0) return null; // never moves (lower=upper=0 forces it to stay 0) - excluded by design
    const newIndex = ((i + bestShift) % SLOTS_PER_DAY + SLOTS_PER_DAY) % SLOTS_PER_DAY;
    return ((bestProfile[newIndex] - v) / v) * 100;
  });

  return {
    profile: bestProfile.map((v) => Math.round(v * 10) / 10),
    baselineCo2G,
    optimizedCo2G,
    savingsG,
    savingsPercent: baselineCo2G > 0 ? (savingsG / baselineCo2G) * 100 : 0,
    shiftSlots: bestShift,
    magnitudePercents,
  };
}

// ── Reporting the shift/magnitude breakdown (shared by CO2 and cost panels) ────

export interface MagnitudeHighlight {
  percent: number; // signed: +12.3 or -30
  oldSlot: number; // original slot index i
  newSlot: number; // (i + shiftSlots) mod 96
  tieCount: number; // count of OTHER original slots tied at this exact percent (0 = none)
}

export interface ReshapeSummary {
  shiftLabel: string; // "Schedule moved 45 min earlier" / "…later" / "No time shift applied"
  increase: MagnitudeHighlight | null; // null if no non-null entries, or max <= 0
  decrease: MagnitudeHighlight | null; // null if no non-null entries, or min >= 0
}

/** Formats a percent for display: whole numbers as-is, else 1 decimal. */
export function formatMagnitudePercent(p: number): string {
  const r = Math.round(p * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function pickExtreme(
  entries: { p: number; i: number }[],
  shiftSlots: number,
  which: "max" | "min"
): MagnitudeHighlight | null {
  if (entries.length === 0) return null;
  const extreme =
    which === "max"
      ? Math.max(...entries.map((e) => e.p))
      : Math.min(...entries.map((e) => e.p));
  if (which === "max" && extreme <= 0) return null;
  if (which === "min" && extreme >= 0) return null;

  // Tie-group on 2-decimal precision, not raw float equality: water-filling
  // ties are exact in practice, but this guards against float noise without
  // merging genuinely-different percents that round the same at display precision.
  const key = Math.round(extreme * 100);
  const tied = entries.filter((e) => Math.round(e.p * 100) === key).sort((a, b) => a.i - b.i);
  const first = tied[0];
  return {
    percent: extreme,
    oldSlot: first.i,
    newSlot: ((first.i + shiftSlots) % SLOTS_PER_DAY + SLOTS_PER_DAY) % SLOTS_PER_DAY,
    tieCount: tied.length - 1,
  };
}

/**
 * Turns optimizeBoundedReshape()'s shiftSlots + magnitudePercents into the
 * two headline facts the result panels show: how far the whole schedule
 * moved (the rigid shift), and the single biggest magnitude increase/
 * decrease from the per-slot resizing - reported against each ORIGINAL
 * slot's own time and value, with "old" → "new" showing where that slot's
 * content ended up after the shift. Shared between ShiftCalculator and
 * CostShiftCalculator so tie-counting and formatting can never drift
 * between the two panels.
 */
export function summarizeReshape(
  shiftSlots: number,
  magnitudePercents: (number | null)[]
): ReshapeSummary {
  const minutes = Math.abs(shiftSlots) * 15;
  const shiftLabel =
    shiftSlots === 0
      ? "No time shift applied"
      : `Schedule moved ${minutes} min ${shiftSlots > 0 ? "later" : "earlier"}`;

  const entries = magnitudePercents
    .map((p, i) => ({ p, i }))
    .filter((e): e is { p: number; i: number } => e.p !== null);

  return {
    shiftLabel,
    increase: pickExtreme(entries, shiftSlots, "max"),
    decrease: pickExtreme(entries, shiftSlots, "min"),
  };
}
