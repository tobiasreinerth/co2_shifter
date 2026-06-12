"use client";

import { useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Cell,
} from "recharts";
import { LoadProfileInput } from "./LoadProfileInput";
import {
  SLOTS_PER_DAY,
  analyzeShifts,
  fetchDayIntensity,
  readingsToIntensityArray,
} from "@/lib/shift-calculator";
import type { LoadProfileSlots, ShiftAnalysisResult } from "@/types";

const REGIONS = ["DE", "FR", "GB", "ES", "NL"];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function ShiftCalculator() {
  const [region, setRegion] = useState("DE");
  const [analysisDate, setAnalysisDate] = useState(todayISO());
  const [loadSlots, setLoadSlots] = useState<LoadProfileSlots>(
    new Array(SLOTS_PER_DAY).fill(0)
  );
  const [result, setResult] = useState<ShiftAnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleCompute = async () => {
    const totalLoad = loadSlots.reduce((s, v) => s + v, 0);
    if (totalLoad === 0) {
      setError("Please enter your energy consumption profile first.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const readings = await fetchDayIntensity(region, analysisDate);
      if (readings.length === 0) {
        setError(
          `No CO2 intensity data found for ${region} on ${analysisDate}. ` +
            "Run the Dagster ingest job for this date first."
        );
        return;
      }
      const intensitySlots = readingsToIntensityArray(readings);
      setResult(analyzeShifts(loadSlots, intensitySlots));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Computation failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Config row */}
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          Grid region
          <select
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            className="rounded-md border px-3 py-2"
          >
            {REGIONS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Analysis date
          <input
            type="date"
            value={analysisDate}
            onChange={(e) => setAnalysisDate(e.target.value)}
            className="rounded-md border px-3 py-2"
          />
        </label>
      </div>

      {/* Load profile */}
      <div>
        <h3 className="mb-3 font-medium">Your energy consumption profile</h3>
        <p className="mb-3 text-sm text-gray-500">
          Enter kWh consumed per 15-min slot for a typical production day, or upload a CSV.
        </p>
        <LoadProfileInput slots={loadSlots} onChange={setLoadSlots} />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        onClick={handleCompute}
        disabled={loading}
        className="rounded-lg bg-green-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
      >
        {loading ? "Computing…" : "Compute optimal shift"}
      </button>

      {result && <ShiftResult result={result} />}
    </div>
  );
}

function ShiftResult({ result }: { result: ShiftAnalysisResult }) {
  const optHours = result.optimalShiftSlots / 4;
  const sign = optHours >= 0 ? "+" : "";

  // Only show every 4th tick label (= 1 h resolution) to avoid crowding
  const tickFormatter = (_: unknown, index: number) =>
    index % 4 === 0 ? result.curve[index]?.shiftLabel ?? "" : "";

  return (
    <div className="space-y-6 rounded-xl border bg-white p-6 shadow-sm">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="Baseline CO2 (no shift)"
          value={`${(result.baselineCo2G / 1000).toFixed(2)} kgCO2`}
        />
        <Stat
          label={`Optimal shift (${sign}${optHours} h)`}
          value={`${(result.optimalCo2G / 1000).toFixed(2)} kgCO2`}
          highlight
        />
        <Stat
          label="CO2 savings"
          value={`${(result.savingsG / 1000).toFixed(2)} kgCO2 (${result.savingsPercent.toFixed(1)} %)`}
          highlight={result.savingsG > 0}
        />
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-gray-600">
          Total daily CO2 by shift amount
        </p>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={result.curve} barCategoryGap={1}>
            <XAxis
              dataKey="shiftLabel"
              tick={{ fontSize: 10 }}
              tickFormatter={tickFormatter}
              interval={0}
            />
            <YAxis
              tick={{ fontSize: 10 }}
              tickFormatter={(v) => `${(v / 1000).toFixed(1)}`}
              unit=" kg"
            />
            <Tooltip
              formatter={(v) => [`${(Number(v) / 1000).toFixed(2)} kgCO2`, "Total CO2"]}
              labelFormatter={(l) => `Shift: ${l}`}
            />
            <ReferenceLine
              x={result.curve[Math.floor(result.curve.length / 2)]?.shiftLabel}
              stroke="#94a3b8"
              strokeDasharray="3 3"
            />
            <Bar dataKey="totalCo2G" radius={[2, 2, 0, 0]}>
              {result.curve.map((pt, i) => (
                <Cell
                  key={i}
                  fill={
                    pt.shiftSlots === result.optimalShiftSlots
                      ? "#16a34a"
                      : pt.isBaseline
                        ? "#64748b"
                        : "#93c5fd"
                  }
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <p className="mt-1 text-xs text-gray-400">
          Green = optimal shift · Grey = your current schedule · Blue = other options
        </p>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold ${highlight ? "text-green-700" : ""}`}>
        {value}
      </p>
    </div>
  );
}
