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
import { DATA_MODE_LABELS, fetchIntensityCurve } from "@/lib/shift-calculator";
import type { DataMode } from "@/lib/shift-calculator";

const DATA_MODE_IDS = Object.keys(DATA_MODE_LABELS) as DataMode[];

/** X-axis tick label: full hours only ("08:00"), empty for the 15/30/45-min slots. */
function slotLabel(i: number): string {
  const h = Math.floor(i / 4);
  const m = (i % 4) * 15;
  if (m === 0) return `${String(h).padStart(2, "0")}:00`;
  return "";
}

/**
 * Full-day CO2 intensity chart: 96 15-min slots as an intensity line with a
 * renewable-share bar underlay. Region and time-period mode are controlled
 * by the dashboard page so ShiftCalculator can share the exact same period.
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
  const [chartData, setChartData] = useState<
    { slot: number; label: string; intensity: number | null; renewable: number | null }[]
  >([]);
  const [caption, setCaption] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const curve = await fetchIntensityCurve(region, dataMode);
        if (!curve) {
          setChartData([]);
          setCaption(null);
          setError(`No CO2 intensity data for ${region}. Run the ingest job first.`);
          return;
        }
        setChartData(
          Array.from({ length: 96 }, (_, i) => ({
            slot: i,
            label: slotLabel(i),
            intensity: curve.intensitySlots[i],
            renewable: curve.renewableSlots[i],
          }))
        );
        setCaption(
          curve.coverageDays !== null
            ? `${curve.label} — ${curve.coverageDays} day${curve.coverageDays === 1 ? "" : "s"} of grid data available`
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
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h3 className="font-medium">CO2 Intensity — 15-min resolution</h3>
        <select
          value={dataMode}
          onChange={(e) => onDataModeChange(e.target.value as DataMode)}
          className="rounded-md border px-2 py-1 text-sm"
        >
          {DATA_MODE_IDS.map((id) => (
            <option key={id} value={id}>{DATA_MODE_LABELS[id]}</option>
          ))}
        </select>
      </div>

      {caption && !error && <p className="mb-3 text-xs text-gray-400">{caption}</p>}
      {error && <p className="mb-3 text-sm text-amber-600">{error}</p>}

      {loading ? (
        <div className="flex h-48 items-center justify-center text-sm text-gray-400">
          Loading…
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#d1d5db" />
            <XAxis
              dataKey="label"
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
              yAxisId="renewable"
              orientation="right"
              tick={{ fontSize: 10 }}
              unit="%"
              domain={[0, 100]}
            />
            <Tooltip
              formatter={(v, name) =>
                name === "intensity"
                  ? [`${v} gCO2/kWh`, "CO2 intensity"]
                  : [`${Number(v).toFixed(1)} %`, "Renewable %"]
              }
              labelFormatter={(_, payload) =>
                payload?.[0]
                  ? `Slot ${payload[0].payload.slot} · ${slotLabel(payload[0].payload.slot) || "—"}`
                  : ""
              }
            />
            <Legend />
            <Bar
              yAxisId="renewable"
              dataKey="renewable"
              fill="#166534"
              opacity={0.6}
              name="Renewable %"
              radius={[1, 1, 0, 0]}
            />
            <Line
              yAxisId="intensity"
              type="monotone"
              dataKey="intensity"
              stroke="#000000"
              dot={false}
              strokeWidth={2}
              name="CO2 intensity"
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
