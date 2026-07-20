"use client";

import { useEffect, useState } from "react";
import {
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import {
  DATA_MODE_IDS,
  DATA_MODE_LABELS,
  daysBeforeIsoDate,
  fetchGenerationMixCurve,
  fetchIntensityCurve,
  hourTickLabel,
  slotLabel,
} from "@/lib/shift-calculator";
import type { DataMode } from "@/lib/shift-calculator";

interface ChartRow {
  slot: number;
  intensity: number | null;
  renewable: number | null;
  nuclear: number | null;
  fossil: number | null;
}

/**
 * Full-day CO2 intensity chart: 96 15-min slots as an intensity line, with a
 * renewable/nuclear/fossil generation-mix stacked underneath it. Region and
 * time-period mode are controlled by the dashboard page so ShiftCalculator
 * can share the exact same period. The mix breakdown is only available for
 * ENTSO-E-sourced regions (it needs per-source generation_mix); the
 * intensity line still renders for other regions even when it's missing.
 */
export function Co2Chart({
  region,
  dataMode,
  onDataModeChange,
}: {
  region: string;
  dataMode: DataMode;
  onDataModeChange: (mode: DataMode) => void;
}) {
  const [chartData, setChartData] = useState<ChartRow[]>([]);
  const [caption, setCaption] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [curve, mix] = await Promise.all([
          fetchIntensityCurve(region, dataMode),
          fetchGenerationMixCurve(region, dataMode),
        ]);
        if (!curve) {
          setChartData([]);
          setCaption(null);
          setError(`No CO2 intensity data for ${region}. Run the ingest job first.`);
          return;
        }
        setChartData(
          Array.from({ length: 96 }, (_, i) => ({
            slot: i,
            intensity: curve.intensitySlots[i],
            renewable: mix?.renewableSlots[i] ?? null,
            nuclear: mix?.nuclearSlots[i] ?? null,
            fossil: mix?.fossilSlots[i] ?? null,
          }))
        );
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
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [region, dataMode]);

  return (
    <div className="rounded-xl border bg-white p-6 shadow-sm">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">Carbon intensity through the day</h3>
        <label className="flex items-center gap-2 text-xs text-gray-500">
          Time period
          <select
            value={dataMode}
            onChange={(e) => onDataModeChange(e.target.value as DataMode)}
            className="rounded-md border px-2 py-1 text-sm text-gray-800"
          >
            {DATA_MODE_IDS.map((id) => (
              <option key={id} value={id}>{DATA_MODE_LABELS[id]}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="mb-3 text-sm text-gray-500">
        Grams of CO2 per kWh generated, in 15-minute steps - lower is cleaner. The stacked bars
        below show what the grid was actually running on: renewable, nuclear, or fossil.
      </p>

      {caption && !error && <p className="mb-3 text-xs text-gray-400">{caption}</p>}
      {error && (
        <p className="mb-3 text-sm text-amber-600">
          We don&apos;t have carbon data for {region} yet for this period. Try a different region
          or time period above.
        </p>
      )}

      {loading ? (
        <div className="flex h-48 items-center justify-center text-sm text-gray-400">
          Loading grid data…
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#d1d5db" />
            <XAxis
              dataKey="slot"
              tickFormatter={(slot: number) => hourTickLabel(slot)}
              tick={{ fontSize: 10 }}
              interval={0}
              tickLine={false}
            />
            <YAxis
              yAxisId="intensity"
              orientation="left"
              tick={{ fontSize: 10 }}
              unit=" g"
              label={{ value: "gCO2/kWh", angle: -90, position: "insideLeft", style: { fontSize: 10 } }}
            />
            <YAxis
              yAxisId="mix"
              orientation="right"
              tick={{ fontSize: 10 }}
              unit="%"
              domain={[0, 100]}
              allowDataOverflow
            />
            <Tooltip
              formatter={(v, name) =>
                String(name).includes("CO2 intensity")
                  ? [`${v} gCO2/kWh`, name]
                  : [`${Number(v).toFixed(1)} %`, name]
              }
              labelFormatter={(_, payload) =>
                payload?.[0]
                  ? `Slot ${payload[0].payload.slot} · ${slotLabel(payload[0].payload.slot)}`
                  : ""
              }
            />
            <Legend />
            <Bar
              yAxisId="mix"
              dataKey="renewable"
              stackId="mix"
              fill="#166534"
              opacity={0.7}
              name="Renewable %"
            />
            <Bar
              yAxisId="mix"
              dataKey="nuclear"
              stackId="mix"
              fill="#4a3aa7"
              opacity={0.7}
              name="Nuclear %"
            />
            <Bar
              yAxisId="mix"
              dataKey="fossil"
              stackId="mix"
              fill="#2a78d6"
              opacity={0.7}
              name="Fossil %"
              radius={[1, 1, 0, 0]}
            />
            <Line
              yAxisId="intensity"
              type="monotone"
              dataKey="intensity"
              stroke="#000000"
              dot={false}
              strokeWidth={2}
              name={dataMode === "latest" ? "CO2 intensity" : "Avg CO2 intensity"}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
