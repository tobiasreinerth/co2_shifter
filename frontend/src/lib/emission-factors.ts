import type { EmissionFactor } from "@/types";
import { supabase } from "./supabase";

/**
 * Loads every lifecycle emission factor (gCO2eq/kWh per energy source),
 * sorted highest-intensity first. Global reference data - not region-specific.
 */
export async function fetchEmissionFactors(): Promise<EmissionFactor[]> {
  const { data, error } = await supabase
    .from("emission_factors")
    .select("psr_type, source_name, factor_gco2eq_per_kwh, is_renewable, citation")
    .order("factor_gco2eq_per_kwh", { ascending: false });

  if (error) throw new Error(error.message);
  return data ?? [];
}

/** "fossil_brown_coal_lignite" -> "Fossil Brown Coal Lignite" */
export function formatSourceName(name: string): string {
  return name
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
