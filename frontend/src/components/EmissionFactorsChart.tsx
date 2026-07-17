"use client";

import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fetchEmissionFactors, formatSourceName } from "@/lib/emission-factors";
import type { EmissionFactor } from "@/types";

// Sequential single-hue ramp (light → dark red): higher intensity = darker.
const RAMP_LOW = "#fee2e2";
const RAMP_HIGH = "#7f1d1d";

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return (
    "#" +
    [r, g, b]
      .map((v) => Math.round(v).toString(16).padStart(2, "0"))
      .join("")
  );
}

function intensityColor(value: number, min: number, max: number): string {
  const t = max > min ? (value - min) / (max - min) : 1;
  const [r1, g1, b1] = hexToRgb(RAMP_LOW);
  const [r2, g2, b2] = hexToRgb(RAMP_HIGH);
  return rgbToHex([r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t]);
}

interface ChartRow {
  label: string;
  factor: number;
  is_renewable: boolean;
  members: { label: string; citation: string }[];
}

/**
 * Groups sources sharing the same factor AND renewable status into one bar
 * (e.g. the 4 fossil sources tied at 820 g/kWh). Grouping never merges across
 * differing renewable status even at equal factors - Nuclear and Wind
 * Offshore both sit at 12 g/kWh but must stay visually distinct.
 */
function groupFactors(factors: EmissionFactor[]): ChartRow[] {
  const groups = new Map<
    string,
    { factor: number; is_renewable: boolean; members: { label: string; citation: string }[] }
  >();

  for (const f of factors) {
    const key = `${f.factor_gco2eq_per_kwh}:${f.is_renewable}`;
    const member = { label: formatSourceName(f.source_name), citation: f.citation };
    const existing = groups.get(key);
    if (existing) {
      existing.members.push(member);
    } else {
      groups.set(key, { factor: f.factor_gco2eq_per_kwh, is_renewable: f.is_renewable, members: [member] });
    }
  }

  return Array.from(groups.values())
    .sort((a, b) => b.factor - a.factor)
    .map((g) => ({
      factor: g.factor,
      is_renewable: g.is_renewable,
      members: g.members,
      label:
        g.members.length === 1
          ? g.members[0].label
          : g.members.length === 2
            ? g.members.map((m) => m.label).join(" / ")
            : `${g.members[0].label} +${g.members.length - 1}`,
    }));
}

/** Custom Y-axis tick: source name plus a 🍃 suffix for renewable sources. */
function SourceTick({
  x,
  y,
  payload,
  rows,
}: {
  x?: number | string;
  y?: number | string;
  payload?: { value: string };
  rows: ChartRow[];
}) {
  if (x === undefined || y === undefined || !payload) return null;
  const row = rows.find((r) => r.label === payload.value);
  return (
    <text x={x} y={y} dy={4} textAnchor="end" fontSize={11} fill="#374151">
      {payload.value}
      {row?.is_renewable ? " 🍃" : ""}
    </text>
  );
}

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: ChartRow }[];
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="max-w-xs rounded-md border bg-white p-2 text-xs shadow-sm">
      <p className="font-medium">
        {row.label}
        {row.is_renewable ? " 🍃" : ""}
      </p>
      <p className="mt-0.5">{row.factor} gCO2eq/kWh</p>
      {row.members.length > 1 ? (
        <ul className="mt-1 space-y-1 text-gray-500">
          {row.members.map((m) => (
            <li key={m.label}>
              <span className="font-medium text-gray-700">{m.label}:</span> {m.citation}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-gray-500">{row.members[0].citation}</p>
      )}
    </div>
  );
}

/**
 * Reference chart: lifecycle CO2 intensity (gCO2eq/kWh) for every energy
 * source technology, sorted highest-intensity first, with a 🍃 marking
 * renewable sources. Sources sharing an identical factor (e.g. the 4 fossil
 * sources tied at 820 g/kWh) are grouped into one bar. Global data
 * (emission_factors table) - does not change per region, since the
 * underlying technology factors are the same everywhere; shown before the
 * country selector for that reason.
 */
export function EmissionFactorsChart() {
  const [factors, setFactors] = useState<EmissionFactor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchEmissionFactors()
      .then(setFactors)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  const rows: ChartRow[] = groupFactors(factors);
  const values = rows.map((r) => r.factor);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;

  return (
    <div className="rounded-xl border bg-white p-6 shadow-sm">
      <h3 className="font-medium">CO2 intensity by energy source</h3>
      <p className="mt-1 text-sm text-gray-500">
        Same everywhere, regardless of region - this is what feeds into every grid&apos;s carbon
        numbers below.
      </p>

      {error && (
        <p className="mt-3 text-sm text-amber-600">
          We couldn&apos;t load the reference emissions data ({error}). Try refreshing the page.
        </p>
      )}

      {loading ? (
        <div className="flex h-48 items-center justify-center text-sm text-gray-400">
          Loading reference data…
        </div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={rows.length * 28 + 20}>
            <BarChart
              data={rows}
              layout="vertical"
              margin={{ top: 4, right: 48, bottom: 4, left: 4 }}
            >
              <XAxis type="number" tick={{ fontSize: 10 }} unit=" g" />
              <YAxis
                type="category"
                dataKey="label"
                width={190}
                interval={0}
                tick={(props) => <SourceTick {...props} rows={rows} />}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="factor" radius={[0, 3, 3, 0]}>
                {rows.map((r) => (
                  <Cell key={r.label} fill={intensityColor(r.factor, min, max)} />
                ))}
                <LabelList
                  dataKey="factor"
                  position="right"
                  formatter={(v: unknown) => `${v} g`}
                  style={{ fontSize: 10, fill: "#374151" }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <p className="mt-2 text-xs text-gray-400">
            🍃 = renewable source · Figures are lifecycle gCO2eq/kWh (i.e. including
            manufacturing and fuel supply, not just the moment of generation) - IPCC AR5 WGIII
            Annex III medians, with Electricity Maps defaults for types IPCC doesn&apos;t cover
          </p>
        </>
      )}
    </div>
  );
}
