"use client";

import { useState } from "react";
import {
  Bar,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { LoadProfileInput } from "./LoadProfileInput";
import {
  SLOTS_PER_DAY,
  DATA_MODE_LABELS,
  analyzeShifts,
  fetchIntensityCurve,
  optimizeBoundedReshape,
  rotateProfile,
  shiftLabel,
  type DataMode,
} from "@/lib/shift-calculator";
import type { LoadProfileSlots } from "@/types";

type OptimizationMode = "rigid" | "reshape";

const OPTIMIZATION_MODES: { id: OptimizationMode; label: string; description: string }[] = [
  {
    id: "rigid",
    label: "Rigid shift (whole day)",
    description:
      "Slides your entire day's schedule earlier or later as one block, anywhere from 12 hours earlier to 12 hours later. The shape of your day never changes — every slot keeps its position relative to every other slot, wrapping at midnight. Best when your process can start earlier/later but its internal sequence must stay intact.",
  },
  {
    id: "reshape",
    label: "Bounded reshaping",
    description:
      "Each 15-minute slot can independently move within the time window and size limit you choose below, staying within your equipment's historical min/max load. Total daily energy stays exactly the same — energy is relocated to lower-carbon moments, not created or removed. Best when individual slots have some flexibility but the day can't be freely rescheduled as a whole.",
  },
];

const SHIFT_MINUTE_OPTIONS = [30, 60, 120] as const;
const MAGNITUDE_PERCENT_OPTIONS = [10, 20, 30] as const;

interface OptimizationResult {
  baselineCo2G: number;
  optimizedCo2G: number;
  savingsG: number;
  savingsPercent: number;
  optimizedProfile: number[]; // the 96-slot "new schedule"
  optimalShiftLabel?: string; // e.g. "+2 h" — rigid mode only
}

/** Slot index → "HH:00" on the hour, blank otherwise (matches Co2Chart's tick style). */
function hourTickLabel(i: number): string {
  return i % 4 === 0 ? `${String(Math.floor(i / 4)).padStart(2, "0")}:00` : "";
}

/**
 * Main dashboard widget: collects an optimization mode and a 96-slot load
 * profile (region and time period come from the dashboard-level selectors —
 * the latter is the same one Co2Chart uses, so the two never disagree on
 * what "the current period" means), then computes either a rigid whole-day
 * shift or a bounded local reshape, rendering the savings stats and one
 * consistent original-vs-new-schedule chart for either mode.
 */
export function ShiftCalculator({ region, dataMode }: { region: string; dataMode: DataMode }) {
  const [mode, setMode] = useState<OptimizationMode>("rigid");
  const [maxShiftMinutes, setMaxShiftMinutes] = useState<number>(60);
  const [magnitudePercent, setMagnitudePercent] = useState<number>(20);
  const [loadSlots, setLoadSlots] = useState<LoadProfileSlots>(
    new Array(SLOTS_PER_DAY).fill(0)
  );
  const [result, setResult] = useState<OptimizationResult | null>(null);
  const [intensityForChart, setIntensityForChart] = useState<number[] | null>(null);
  const [caption, setCaption] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleCompute = async () => {
    const totalLoad = loadSlots.reduce((s, v) => s + v, 0);
    if (totalLoad === 0) {
      setError("Please enter your energy consumption profile first.");
      return;
    }
    setError(null);
    setResult(null);
    setIntensityForChart(null);
    setCaption(null);
    setLoading(true);
    try {
      const curve = await fetchIntensityCurve(region, dataMode);
      if (!curve) {
        setError(
          `No CO2 intensity data found for ${region}. Run the Dagster ingest job first.`
        );
        return;
      }
      setCaption(
        curve.coverageDays !== null
          ? `${curve.label} — ${curve.coverageDays} day${curve.coverageDays === 1 ? "" : "s"} of grid data available`
          : curve.label
      );
      setIntensityForChart(curve.intensitySlots);

      if (mode === "rigid") {
        const shift = analyzeShifts(loadSlots, curve.intensitySlots);
        setResult({
          baselineCo2G: shift.baselineCo2G,
          optimizedCo2G: shift.optimalCo2G,
          savingsG: shift.savingsG,
          savingsPercent: shift.savingsPercent,
          optimizedProfile: rotateProfile(loadSlots, shift.optimalShiftSlots),
          optimalShiftLabel: shiftLabel(shift.optimalShiftSlots),
        });
      } else {
        const maxShiftSlots = maxShiftMinutes / 15;
        const magnitudeBand = magnitudePercent / 100;
        const reshape = optimizeBoundedReshape(
          loadSlots,
          curve.intensitySlots,
          maxShiftSlots,
          magnitudeBand
        );
        setResult({
          baselineCo2G: reshape.baselineCo2G,
          optimizedCo2G: reshape.optimizedCo2G,
          savingsG: reshape.savingsG,
          savingsPercent: reshape.savingsPercent,
          optimizedProfile: reshape.profile,
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Computation failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      <p className="text-xs text-gray-500">
        Uses the time period selected in the CO2 Intensity chart above (
        {DATA_MODE_LABELS[dataMode]}).
      </p>

      {/* Optimization mode: both options explained up front, not just the selected one */}
      <div>
        <p className="mb-2 text-sm font-medium">Optimization</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {OPTIMIZATION_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className={`rounded-lg border p-3 text-left ${
                mode === m.id
                  ? "border-green-600 bg-green-50"
                  : "hover:border-gray-400"
              }`}
            >
              <p className="text-sm font-medium">{m.label}</p>
              <p className="mt-1 text-xs text-gray-500">{m.description}</p>
            </button>
          ))}
        </div>
      </div>

      {mode === "reshape" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            Max time shift
            <select
              value={maxShiftMinutes}
              onChange={(e) => setMaxShiftMinutes(Number(e.target.value))}
              className="rounded-md border px-3 py-2"
            >
              {SHIFT_MINUTE_OPTIONS.map((m) => (
                <option key={m} value={m}>{m} min</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Max size change
            <select
              value={magnitudePercent}
              onChange={(e) => setMagnitudePercent(Number(e.target.value))}
              className="rounded-md border px-3 py-2"
            >
              {MAGNITUDE_PERCENT_OPTIONS.map((p) => (
                <option key={p} value={p}>±{p}%</option>
              ))}
            </select>
          </label>
        </div>
      )}

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
        {loading ? "Computing…" : "Compute optimal schedule"}
      </button>

      {result && caption && <p className="text-xs text-gray-400">{caption}</p>}

      {result && intensityForChart && (
        <OptimizationResultView
          result={result}
          original={loadSlots}
          intensitySlots={intensityForChart}
        />
      )}
    </div>
  );
}

/**
 * Renders the outcome for either optimization mode with one consistent
 * chart: original schedule (black), new schedule (dark green), and the
 * grid's CO2 intensity per slot as grey bars on a compressed secondary axis
 * (deliberately smaller than the load curves).
 */
function OptimizationResultView({
  result,
  original,
  intensitySlots,
}: {
  result: OptimizationResult;
  original: LoadProfileSlots;
  intensitySlots: number[];
}) {
  const chartData = Array.from({ length: SLOTS_PER_DAY }, (_, i) => ({
    label: hourTickLabel(i),
    original: original[i],
    optimized: result.optimizedProfile[i],
    intensity: intensitySlots[i],
  }));

  return (
    <div className="space-y-6 rounded-xl border bg-white p-6 shadow-sm">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="Baseline CO2 (original schedule)"
          value={`${(result.baselineCo2G / 1000).toFixed(2)} kgCO2`}
        />
        <Stat
          label={result.optimalShiftLabel ? `Optimal shift (${result.optimalShiftLabel})` : "Optimized CO2"}
          value={`${(result.optimizedCo2G / 1000).toFixed(2)} kgCO2`}
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
          Load profile: original vs. new schedule
        </p>
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#d1d5db" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={0} tickLine={false} />
            <YAxis yAxisId="load" tick={{ fontSize: 10 }} unit=" kWh" />
            <YAxis
              yAxisId="intensity"
              orientation="right"
              tick={{ fontSize: 10 }}
              unit=" g"
              domain={[0, (max: number) => max * 2.5]}
            />
            <Tooltip
              formatter={(v, name) => {
                if (name === "Grid CO2 intensity") return [`${v} gCO2/kWh`, name];
                return [`${v} kWh`, name];
              }}
              labelFormatter={(l) => `Time: ${l || "—"}`}
            />
            <Legend />
            <Bar
              yAxisId="intensity"
              dataKey="intensity"
              fill="#9ca3af"
              opacity={0.5}
              name="Grid CO2 intensity"
              radius={[1, 1, 0, 0]}
            />
            <Line
              yAxisId="load"
              type="monotone"
              dataKey="original"
              stroke="#000000"
              strokeWidth={2}
              dot={false}
              name="Original schedule"
            />
            <Line
              yAxisId="load"
              type="monotone"
              dataKey="optimized"
              stroke="#166534"
              strokeWidth={2}
              dot={false}
              name="New schedule"
            />
          </ComposedChart>
        </ResponsiveContainer>
        <p className="mt-1 text-xs text-gray-400">
          Black = your original schedule · Dark green = the optimized schedule · Grey bars =
          grid CO2 intensity for that slot
        </p>
      </div>
    </div>
  );
}

/** Small labeled stat tile; highlight renders the value in green. */
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
