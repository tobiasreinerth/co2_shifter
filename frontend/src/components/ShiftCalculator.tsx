"use client";

import { useEffect, useState } from "react";
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
import {
  SLOTS_PER_DAY,
  DATA_MODE_IDS,
  DATA_MODE_LABELS,
  daysBeforeIsoDate,
  fetchIntensityCurve,
  formatMagnitudePercent,
  hourTickLabel,
  optimizeBoundedReshape,
  slotLabel,
  summarizeReshape,
  type DataMode,
} from "@/lib/shift-calculator";
import type { LoadProfileSlots } from "@/types";

const SHIFT_MINUTE_OPTIONS = [0, 30, 60, 120] as const;
const MAGNITUDE_PERCENT_OPTIONS = [0, 10, 20, 30] as const;

interface OptimizationResult {
  baselineCo2G: number;
  optimizedCo2G: number;
  savingsG: number;
  savingsPercent: number;
  optimizedProfile: number[]; // the 96-slot "new schedule"
  shiftSlots: number;
  magnitudePercents: (number | null)[];
}

/**
 * CO2 optimization widget: region and the load profile come from the
 * dashboard page; time period is its own independent "Time period" select
 * here (defaulting to "3 months (91 days)" - the most robust/representative
 * window), deliberately decoupled from Co2Chart's -
 * exploring a shift/magnitude combo against a different window than what
 * Step 2 happens to show shouldn't require scrolling back up to change it
 * there too. Always runs optimizeBoundedReshape() - a whole-day rigid shift
 * is just the 0%-load-change special case of this (only the time-shift
 * search applies), so there's no separate mode to pick. Never renders cost
 * numbers - CostShiftCalculator is a fully separate panel for that.
 */
export function ShiftCalculator({
  region,
  loadSlots,
}: {
  region: string;
  loadSlots: LoadProfileSlots;
}) {
  const [dataMode, setDataMode] = useState<DataMode>("avg91");
  const [maxShiftMinutes, setMaxShiftMinutes] = useState<number>(60);
  const [magnitudePercent, setMagnitudePercent] = useState<number>(20);
  const [result, setResult] = useState<OptimizationResult | null>(null);
  const [intensityForChart, setIntensityForChart] = useState<number[] | null>(null);
  const [caption, setCaption] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Clears any previously-computed result whenever the inputs it was computed
  // from change, so a stale number/chart never lingers after the user tweaks
  // region, period, or the schedule - they must click Optimize again to see
  // a result for the new inputs.
  useEffect(() => {
    setResult(null);
    setIntensityForChart(null);
    setCaption(null);
    setError(null);
  }, [region, dataMode, loadSlots]);

  const handleCompute = async () => {
    const totalLoad = loadSlots.reduce((s, v) => s + v, 0);
    if (totalLoad === 0) {
      setError("Add your production schedule in Step 3 above before running this.");
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
          `We don't have carbon data for ${region} for this period yet - try a different region or time period above.`
        );
        return;
      }
      const windowDays = dataMode === "avg28" ? 28 : dataMode === "avg91" ? 91 : null;
      const dateRange =
        curve.windowEndDate && windowDays
          ? `${daysBeforeIsoDate(curve.windowEndDate, windowDays - 1)} to ${curve.windowEndDate}`
          : null;
      setCaption(
        curve.coverageDays !== null
          ? `${curve.label} average - ${curve.coverageDays} day${curve.coverageDays === 1 ? "" : "s"} of grid data available${dateRange ? ` (${dateRange})` : ""}`
          : curve.label
      );
      setIntensityForChart(curve.intensitySlots);

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
        shiftSlots: reshape.shiftSlots,
        magnitudePercents: reshape.magnitudePercents,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong while computing this - please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <p className="mb-2 text-sm font-medium">How this works</p>
        <ul className="list-disc space-y-1 pl-5 text-xs text-gray-500">
          <li>The whole schedule shifts once, by up to the time window you choose below</li>
          <li>On top of that, each 15-minute slot&apos;s amount can also change by up to the percentage you choose below</li>
          <li>Load never exceeds your energy profile&apos;s daily maximum, and never drops below its daily minimum</li>
          <li>Total daily energy stays exactly the same - consumption is relocated to cleaner moments, not added or removed</li>
        </ul>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          Time period
          <select
            value={dataMode}
            onChange={(e) => setDataMode(e.target.value as DataMode)}
            className="rounded-md border px-3 py-2"
          >
            {DATA_MODE_IDS.map((id) => (
              <option key={id} value={id}>{DATA_MODE_LABELS[id]}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          How far can a slot move?
          <select
            value={maxShiftMinutes}
            onChange={(e) => setMaxShiftMinutes(Number(e.target.value))}
            className="rounded-md border px-3 py-2"
          >
            {SHIFT_MINUTE_OPTIONS.map((m) => (
              <option key={m} value={m}>{m === 0 ? "no time shift, resizing only" : `up to ${m} min earlier/later`}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          How much can load change?
          <select
            value={magnitudePercent}
            onChange={(e) => setMagnitudePercent(Number(e.target.value))}
            className="rounded-md border px-3 py-2"
          >
            {MAGNITUDE_PERCENT_OPTIONS.map((p) => (
              <option key={p} value={p}>{p === 0 ? "no resizing, shift only" : `up to ±${p}% per slot`}</option>
            ))}
          </select>
        </label>
      </div>

      {maxShiftMinutes === 0 && magnitudePercent === 0 && (
        <p className="text-sm text-red-600">
          With no time shift and no resizing allowed, the schedule can&apos;t change - you won&apos;t
          see any difference. Increase one of the two settings above.
        </p>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        onClick={handleCompute}
        disabled={loading}
        className="rounded-lg bg-green-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
      >
        {loading ? "Computing…" : "Optimize my carbon savings"}
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
 * Renders the optimization outcome: original schedule (black), new schedule
 * (dark green), and the grid's CO2 intensity per slot as grey bars on a
 * compressed secondary axis (deliberately smaller than the load curves).
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
    slot: i,
    original: original[i],
    optimized: result.optimizedProfile[i],
    intensity: intensitySlots[i],
  }));

  const summary = summarizeReshape(result.shiftSlots, result.magnitudePercents);

  return (
    <div className="space-y-6 rounded-xl border bg-white p-6 shadow-sm">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="Your schedule today"
          value={`${(result.baselineCo2G / 1000).toFixed(2)} kg CO2`}
        />
        <Stat
          label="Shifted schedule"
          value={`${(result.optimizedCo2G / 1000).toFixed(2)} kg CO2`}
          highlight
        />
        <Stat
          label="What you'd save"
          value={`${(result.savingsG / 1000).toFixed(2)} kg CO2 (${result.savingsPercent.toFixed(1)} %)`}
          highlight={result.savingsG > 0}
        />
      </div>

      <div className="space-y-1 text-sm text-gray-600">
        <p>{summary.shiftLabel}</p>
        {summary.increase && (
          <p>
            Largest increase: +{formatMagnitudePercent(summary.increase.percent)}% at{" "}
            {slotLabel(summary.increase.oldSlot)} (old)
            {summary.increase.oldSlot !== summary.increase.newSlot &&
              ` → ${slotLabel(summary.increase.newSlot)} (new)`}
            {summary.increase.tieCount > 0 &&
              ` (and ${summary.increase.tieCount} more slot${summary.increase.tieCount === 1 ? "" : "s"} at +${formatMagnitudePercent(summary.increase.percent)}%)`}
          </p>
        )}
        {summary.decrease && (
          <p>
            Largest decrease: {formatMagnitudePercent(summary.decrease.percent)}% at{" "}
            {slotLabel(summary.decrease.oldSlot)} (old)
            {summary.decrease.oldSlot !== summary.decrease.newSlot &&
              ` → ${slotLabel(summary.decrease.newSlot)} (new)`}
            {summary.decrease.tieCount > 0 &&
              ` (and ${summary.decrease.tieCount} more slot${summary.decrease.tieCount === 1 ? "" : "s"} at ${formatMagnitudePercent(summary.decrease.percent)}%)`}
          </p>
        )}
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-gray-600">
          Your original schedule vs. the lower-carbon version
        </p>
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#d1d5db" />
            <XAxis
              dataKey="slot"
              tickFormatter={(slot: number) => hourTickLabel(slot)}
              tick={{ fontSize: 10 }}
              interval={0}
              tickLine={false}
            />
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
              labelFormatter={(_, payload) =>
                payload?.[0] ? `Time: ${slotLabel(payload[0].payload.slot)}` : ""
              }
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
              name="Shifted schedule"
            />
          </ComposedChart>
        </ResponsiveContainer>
        <p className="mt-1 text-xs text-gray-400">
          Black = your original schedule · Dark green = the shifted schedule · Grey bars = grid
          carbon intensity for that slot
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
