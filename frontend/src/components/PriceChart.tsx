"use client";

import { useEffect, useState } from "react";
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { fetchPriceCurve } from "@/lib/cost-shift-calculator";
import { DATA_MODE_LABELS, hourTickLabel, slotLabel } from "@/lib/shift-calculator";
import type { DataMode } from "@/lib/shift-calculator";

const DATA_MODE_IDS = Object.keys(DATA_MODE_LABELS) as DataMode[];

/**
 * Full-day day-ahead price chart: 96 15-min slots as a price line. Region
 * is shared with Co2Chart; the time-period mode is this chart's own (a
 * separate selector from Co2Chart's), since carbon intensity and price
 * windows are often worth comparing independently.
 */
export function PriceChart({
  region,
  dataMode,
  onDataModeChange,
}: {
  region: string;
  dataMode: DataMode;
  onDataModeChange: (mode: DataMode) => void;
}) {
  const [chartData, setChartData] = useState<
    { slot: number; price: number | null }[]
  >([]);
  const [currency, setCurrency] = useState("EUR");
  const [caption, setCaption] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const curve = await fetchPriceCurve(region, dataMode);
        if (!curve) {
          setChartData([]);
          setCaption(null);
          setError(`No day-ahead price data for ${region}. Run the ingest job first.`);
          return;
        }
        setCurrency(curve.currency);
        setChartData(
          Array.from({ length: 96 }, (_, i) => ({
            slot: i,
            price: curve.priceSlots[i],
          }))
        );
        setCaption(
          curve.coverageDays !== null
            ? `${curve.label} - ${curve.coverageDays} day${curve.coverageDays === 1 ? "" : "s"} of price data available`
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
        <h3 className="font-medium">Wholesale electricity price through the day</h3>
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
        What a megawatt-hour costs on the wholesale market, in 15-minute steps - a stand-in for
        how your bill moves through the day.
      </p>

      {caption && !error && <p className="mb-3 text-xs text-gray-400">{caption}</p>}
      {error && (
        <p className="mb-3 text-sm text-amber-600">
          We don&apos;t have day-ahead price data for {region} yet for this period. Try a
          different region or time period above.
        </p>
      )}

      {loading ? (
        <div className="flex h-48 items-center justify-center text-sm text-gray-400">
          Loading price data…
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
              tick={{ fontSize: 10 }}
              label={{
                value: `${currency}/MWh`,
                angle: -90,
                position: "insideLeft",
                style: { fontSize: 10 },
              }}
            />
            <Tooltip
              formatter={(v) => [`${v} ${currency}/MWh`, "Day-ahead price"]}
              labelFormatter={(_, payload) =>
                payload?.[0]
                  ? `Slot ${payload[0].payload.slot} · ${slotLabel(payload[0].payload.slot)}`
                  : ""
              }
            />
            <Legend />
            <Line
              type="monotone"
              dataKey="price"
              stroke="#1d4ed8"
              dot={false}
              strokeWidth={2}
              name="Day-ahead price"
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
