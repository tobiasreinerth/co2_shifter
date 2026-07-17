export interface Co2Reading {
  id: string;
  region: string;
  timestamp: string;       // ISO, start of 15-min slot
  intensity_gco2_kwh: number;
  renewable_percentage: number | null;
  // Share % of generation per source, e.g. {"solar": 20.1, "fossil_gas": 34.2};
  // null for rows not ingested from ENTSO-E
  generation_mix?: Record<string, number> | null;
  source: string;
}

// One row of the avg_intensity_by_slot() RPC: rolling average per
// 15-min slot-of-day (UTC) over a caller-chosen trailing window
export interface AvgIntensitySlot {
  slot_index: number;               // 0 = 00:00 UTC, 95 = 23:45
  slot_time: string;                // "13:15:00" - start of the window
  avg_intensity_gco2_kwh: number;
  avg_renewable_percentage: number | null;
  days_covered: number;             // how many days of history back this slot
}

// One row of the avg_generation_mix_by_slot() RPC: rolling average
// renewable/nuclear/fossil share of generation per 15-min slot-of-day (UTC)
export interface AvgGenerationMixSlot {
  slot_index: number;
  slot_time: string;
  avg_renewable_percentage: number;
  avg_nuclear_percentage: number;
  avg_fossil_percentage: number;
  days_covered: number;
}

// 96-element array (slot 0 = 00:00, slot 95 = 23:45)
export type LoadProfileSlots = number[];  // kWh per 15-min slot

export interface LoadProfile {
  id: string;
  company_id: string | null;
  name: string;
  region: string;
  created_at: string;
  slots?: LoadProfileSlots;
}

export interface ShiftAnalysis {
  id: string;
  company_id: string | null;
  profile_id: string | null;
  region: string;
  analysis_date: string;   // ISO date
  shift_slots: number;     // 0 = baseline; each unit = 15 min
  baseline_co2_g: number | null;
  shifted_co2_g: number | null;
  savings_co2_g: number | null;
  created_at: string;
}

// Result of the "bounded local reshaping" optimization: each slot moved by
// at most ±60 min and rescaled by at most ±20%, total energy conserved. A
// rigid whole-day shift is the magnitudeBand=0 special case of this.
export interface BoundedReshapeResult {
  profile: LoadProfileSlots;  // the reshaped 96-slot load
  baselineCo2G: number;
  optimizedCo2G: number;
  savingsG: number;
  savingsPercent: number;
}

export interface EmissionFactor {
  psr_type: string;
  source_name: string;             // e.g. "fossil_gas" - matches generation_mix keys
  factor_gco2eq_per_kwh: number;
  is_renewable: boolean;
  citation: string;
}

// ── Day-ahead prices (cost dimension - kept separate from CO2 types above) ─────

export interface PriceReading {
  id: string;
  region: string;
  timestamp: string;   // ISO, start of 15-min slot
  price: number;        // per MWh, in `currency`
  currency: string;     // not all bidding zones settle in EUR
  source: string;
}

// One row of the avg_price_by_slot() RPC: rolling average per 15-min
// slot-of-day (UTC) over a caller-chosen trailing window
export interface AvgPriceSlot {
  slot_index: number;   // 0 = 00:00 UTC, 95 = 23:45
  slot_time: string;    // "13:15:00" - start of the window
  avg_price: number;
  currency: string;
  days_covered: number;
}

// Mirrors BoundedReshapeResult but for cost - never mixed with the CO2 result
export interface CostBoundedReshapeResult {
  profile: LoadProfileSlots;
  baselineCost: number;
  optimizedCost: number;
  savingsCost: number;
  savingsPercent: number;
  currency: string;
}
