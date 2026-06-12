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
import { fetchDayIntensity } from "@/lib/shift-calculator";
import type { Co2Reading } from "@/types";

const REGIONS = ["DE", "FR", "GB", "ES", "NL"];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function slotLabel(i: number): string {
  const h = Math.floor(i / 4);
  const m = (i % 4) * 15;
  if (m === 0) return `${String(h).padStart(2, "0")}:00`;
  return "";
}

export function Co2Chart() {
  const [region, setRegion] = useState("DE");
  const [date, setDate] = useState(todayISO());
  const [readings, setReadings] = useState<Co2Reading[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchDayIntensity(region, date);
        setReadings(data);
        if (data.length === 0)
          setError("No data for this region / date. Run the ingest job first.");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [region, date]);

  // Build 96-slot chart data
  const chartData = Array.from({ length: 96 }, (_, i) => ({
    slot: i,
    label: slotLabel(i),
    intensity: null as number | null,
    renewable: null as number | null,
  }));

  for (const r of readings) {
    const dt = new Date(r.timestamp);
    const slot = (dt.getUTCHours() * 60 + dt.getUTCMinutes()) / 15;
    if (slot >= 0 && slot < 96) {
      chartData[slot].intensity = r.intensity_gco2_kwh;
      chartData[slot].renewable = r.renewable_percentage;
    }
  }

  return (
    <div className="rounded-xl border bg-white p-6 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h3 className="font-medium">CO2 Intensity — 15-min resolution</h3>
        <select
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          className="rounded-md border px-2 py-1 text-sm"
        >
          {REGIONS.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-md border px-2 py-1 text-sm"
        />
      </div>

      {error && (
        <p className="mb-3 text-sm text-amber-600">{error}</p>
      )}

      {loading ? (
        <div className="flex h-48 items-center justify-center text-sm text-gray-400">
          Loading…
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
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
              fill="#bbf7d0"
              opacity={0.6}
              name="Renewable %"
              radius={[1, 1, 0, 0]}
            />
            <Line
              yAxisId="intensity"
              type="monotone"
              dataKey="intensity"
              stroke="#16a34a"
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
