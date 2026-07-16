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
  slot_time: string;                // "13:15:00" — start of the window
  avg_intensity_gco2_kwh: number;
  avg_renewable_percentage: number | null;
  days_covered: number;             // how many days of history back this slot
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

// One point on the "CO2 vs shift" curve
export interface ShiftPoint {
  shiftSlots: number;       // -48 … +48  (= -12 h … +12 h)
  shiftLabel: string;       // e.g. "-3 h", "+1.5 h"
  totalCo2G: number;
  isBaseline: boolean;
}

export interface ShiftAnalysisResult {
  baselineCo2G: number;
  optimalShiftSlots: number;
  optimalCo2G: number;
  savingsG: number;
  savingsPercent: number;
  curve: ShiftPoint[];
}

// Result of the "bounded local reshaping" optimization (Option 2): each slot
// moved by at most ±60 min and rescaled by at most ±20%, total energy conserved
export interface BoundedReshapeResult {
  profile: LoadProfileSlots;  // the reshaped 96-slot load
  baselineCo2G: number;
  optimizedCo2G: number;
  savingsG: number;
  savingsPercent: number;
}

export interface EmissionFactor {
  psr_type: string;
  source_name: string;             // e.g. "fossil_gas" — matches generation_mix keys
  factor_gco2eq_per_kwh: number;
  is_renewable: boolean;
  citation: string;
}
