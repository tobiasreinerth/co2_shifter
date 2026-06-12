export interface Co2Reading {
  id: string;
  region: string;
  timestamp: string;       // ISO, start of 15-min slot
  intensity_gco2_kwh: number;
  renewable_percentage: number | null;
  source: string;
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
