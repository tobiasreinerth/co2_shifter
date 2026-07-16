"use client";

import { useState } from "react";
import { Co2Chart } from "@/components/Co2Chart";
import { EmissionFactorsChart } from "@/components/EmissionFactorsChart";
import { ShiftCalculator } from "@/components/ShiftCalculator";
import { REGIONS } from "@/lib/regions";
import type { DataMode } from "@/lib/shift-calculator";

/**
 * Dashboard: a single country selector and a single time-period selector
 * (owned by Co2Chart, lifted here) drive everything below the emission-
 * factors reference chart — the intensity chart and the shift calculator
 * always agree on which region and which period they're looking at.
 */
export default function DashboardPage() {
  const [region, setRegion] = useState("DE");
  const [dataMode, setDataMode] = useState<DataMode>("latest");

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold">Shift Calculator</h2>
        <p className="mt-1 text-sm text-gray-500">
          Enter your load and time windows to estimate CO2 savings.
        </p>
      </div>

      <EmissionFactorsChart />

      <label className="flex max-w-xs flex-col gap-1 text-sm">
        Country / grid region
        <select
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          className="rounded-md border px-3 py-2"
        >
          {REGIONS.map((r) => (
            <option key={r.code} value={r.code}>{r.label}</option>
          ))}
        </select>
      </label>

      <Co2Chart region={region} dataMode={dataMode} onDataModeChange={setDataMode} />
      <ShiftCalculator region={region} dataMode={dataMode} />
    </div>
  );
}
