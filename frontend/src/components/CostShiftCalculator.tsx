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
import {
  fetchPriceCurve,
  optimizeBoundedCostReshape,
} from "@/lib/cost-shift-calculator";
import {
  SLOTS_PER_DAY,
  DATA_MODE_LABELS,
  hourTickLabel,
  slotLabel,
  type DataMode,
} from "@/lib/shift-calculator";
import type { LoadProfileSlots } from "@/types";

const SHIFT_MINUTE_OPTIONS = [0, 30, 60, 120] as const;
const MAGNITUDE_PERCENT_OPTIONS = [0, 10, 20, 30] as const;

interface OptimizationResult {
  baselineCost: number;
  optimizedCost: number;
  savingsCost: number;
  savingsPercent: number;
  currency: string;
  optimizedProfile: number[]; // the 96-slot "new schedule"
}

/**
 * Cost optimization widget: the price/cost analog of ShiftCalculator, kept
 * as a fully separate component and result panel per the "never mix cost
 * and CO2" requirement - region, time period, and the load profile all come
 * from the dashboard page, so the two panels always analyze the identical
 * schedule, just under a different cost function. Always runs
 * optimizeBoundedCostReshape() - a whole-day rigid shift is just the
 * 0%-load-change special case of this, so there's no separate mode to pick.
 */
export function CostShiftCalculator({
  region,
  dataMode,
  loadSlots,
}: {
  region: string;
  dataMode: DataMode;
  loadSlots: LoadProfileSlots;
}) {
  const [maxShiftMinutes, setMaxShiftMinutes] = useState<number>(60);
  const [magnitudePercent, setMagnitudePercent] = useState<number>(20);
  const [result, setResult] = useState<OptimizationResult | null>(null);
  const [priceForChart, setPriceForChart] = useState<number[] | null>(null);
  const [currency, setCurrency] = useState("EUR");
  const [caption, setCaption] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleCompute = async () => {
    const totalLoad = loadSlots.reduce((s, v) => s + v, 0);
    if (totalLoad === 0) {
      setError("Add your production schedule in Step 3 above before running this.");
      return;
    }
    setError(null);
    setResult(null);
    setPriceForChart(null);
    setCaption(null);
    setLoading(true);
    try {
      const curve = await fetchPriceCurve(region, dataMode);
      if (!curve) {
        setError(
          `We don't have day-ahead price data for ${region} for this period yet - try a different region or time period above.`
        );
        return;
      }
      setCurrency(curve.currency);
      setCaption(
        curve.coverageDays !== null
          ? `${curve.label} - ${curve.coverageDays} day${curve.coverageDays === 1 ? "" : "s"} of price data available`
          : curve.label
      );
      setPriceForChart(curve.priceSlots);

      const maxShiftSlots = maxShiftMinutes / 15;
      const magnitudeBand = magnitudePercent / 100;
      const reshape = optimizeBoundedCostReshape(
        loadSlots,
        curve.priceSlots,
        curve.currency,
        maxShiftSlots,
        magnitudeBand
      );
      setResult({
        baselineCost: reshape.baselineCost,
        optimizedCost: reshape.optimizedCost,
        savingsCost: reshape.savingsCost,
        savingsPercent: reshape.savingsPercent,
        currency: reshape.currency,
        optimizedProfile: reshape.profile,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong while computing this - please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      <p className="text-xs text-gray-500">
        Uses the time period you picked above in step 2 (
        {DATA_MODE_LABELS[dataMode]}) and the production schedule from Step 3 - a separate,
        cost-only calculation that&apos;s never combined with the carbon numbers.
      </p>

      <div>
        <p className="mb-2 text-sm font-medium">How this works</p>
        <ul className="list-disc space-y-1 pl-5 text-xs text-gray-500">
          <li>Each 15-minute slot can move within the time window you choose below</li>
          <li>Load never exceeds your equipment&apos;s historical maximum, and never drops below its historical minimum</li>
          <li>Total daily energy stays exactly the same - consumption is relocated to cheaper moments, not added or removed</li>
        </ul>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
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
        className="rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? "Computing…" : "Optimize my cost savings"}
      </button>

      {result && caption && <p className="text-xs text-gray-400">{caption}</p>}

      {result && priceForChart && (
        <OptimizationResultView
          result={result}
          original={loadSlots}
          priceSlots={priceForChart}
          currency={currency}
        />
      )}
    </div>
  );
}

/**
 * Renders the optimization outcome: original schedule (black), new schedule
 * (blue - deliberately distinct from ShiftCalculator's dark green so a cost
 * result and a CO2 result are never visually confusable), and the day-ahead
 * price per slot as grey bars on a compressed secondary axis.
 */
function OptimizationResultView({
  result,
  original,
  priceSlots,
  currency,
}: {
  result: OptimizationResult;
  original: LoadProfileSlots;
  priceSlots: number[];
  currency: string;
}) {
  const chartData = Array.from({ length: SLOTS_PER_DAY }, (_, i) => ({
    slot: i,
    original: original[i],
    optimized: result.optimizedProfile[i],
    price: priceSlots[i],
  }));

  return (
    <div className="space-y-6 rounded-xl border bg-white p-6 shadow-sm">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="Your schedule today"
          value={`${result.baselineCost.toFixed(2)} ${result.currency}`}
        />
        <Stat
          label="Shifted schedule"
          value={`${result.optimizedCost.toFixed(2)} ${result.currency}`}
          highlight
        />
        <Stat
          label="What you'd save"
          value={`${result.savingsCost.toFixed(2)} ${result.currency} (${result.savingsPercent.toFixed(1)} %)`}
          highlight={result.savingsCost > 0}
        />
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-gray-600">
          Your original schedule vs. the lower-cost version
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
              yAxisId="price"
              orientation="right"
              tick={{ fontSize: 10 }}
              domain={[0, (max: number) => max * 2.5]}
              tickFormatter={(v: number) => Math.round(v).toString()}
            />
            <Tooltip
              formatter={(v, name) => {
                if (name === "Day-ahead price") return [`${v} ${currency}/MWh`, name];
                return [`${v} kWh`, name];
              }}
              labelFormatter={(_, payload) =>
                payload?.[0] ? `Time: ${slotLabel(payload[0].payload.slot)}` : ""
              }
            />
            <Legend />
            <Bar
              yAxisId="price"
              dataKey="price"
              fill="#9ca3af"
              opacity={0.5}
              name="Day-ahead price"
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
              stroke="#1d4ed8"
              strokeWidth={2}
              dot={false}
              name="Shifted schedule"
            />
          </ComposedChart>
        </ResponsiveContainer>
        <p className="mt-1 text-xs text-gray-400">
          Black = your original schedule · Blue = the shifted schedule · Grey bars =
          day-ahead price for that slot
        </p>
      </div>
    </div>
  );
}

/** Small labeled stat tile; highlight renders the value in blue. */
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
      <p className={`mt-0.5 text-lg font-semibold ${highlight ? "text-blue-700" : ""}`}>
        {value}
      </p>
    </div>
  );
}
