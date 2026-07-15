"use client";

import { Fragment, useRef } from "react";
import type { LoadProfileSlots } from "@/types";
import { SLOTS_PER_DAY } from "@/lib/shift-calculator";

interface Props {
  slots: LoadProfileSlots;
  onChange: (slots: LoadProfileSlots) => void;
}

function slotLabel(i: number): string {
  const h = Math.floor(i / 4);
  const m = (i % 4) * 15;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function parseCSV(text: string): LoadProfileSlots | string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // Accept: single-column CSV (96 rows of kWh values)
  // or two-column CSV (time, kwh) — we just take the last numeric column
  const values: number[] = [];
  for (const line of lines) {
    const cols = line.split(/[,;\t]/);
    const raw = cols[cols.length - 1].replace(",", ".");
    const n = parseFloat(raw);
    if (isNaN(n)) continue; // skip header rows
    if (n < 0) return "kWh values must be ≥ 0";
    values.push(n);
  }

  if (values.length !== SLOTS_PER_DAY)
    return `Expected ${SLOTS_PER_DAY} data rows, found ${values.length}`;

  return values;
}

export function LoadProfileInput({ slots, onChange }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

  const handleCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const result = parseCSV(text);
      if (typeof result === "string") {
        alert(`CSV error: ${result}`);
        return;
      }
      onChange(result);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleCellChange = (i: number, val: string) => {
    const n = parseFloat(val);
    if (isNaN(n) || n < 0) return;
    const next = [...slots];
    next[i] = n;
    onChange(next);
  };

  const totalKwh = slots.reduce((s, v) => s + v, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-gray-50"
        >
          Upload CSV
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.tsv,.txt"
          className="hidden"
          onChange={handleCSV}
        />
        <span className="text-sm text-gray-500">
          CSV: 96 rows, one kWh value per row (= one 15-min slot, 00:00 first)
        </span>
      </div>

      <p className="text-xs text-gray-400">
        Total daily consumption: <strong>{totalKwh.toFixed(1)} kWh</strong>
      </p>

      {/* Compact grid: 4 columns × 24 rows = 96 slots */}
      <div className="max-h-72 overflow-y-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-gray-50">
            <tr>
              <th className="px-2 py-1 text-left font-medium text-gray-500">Time</th>
              <th className="px-2 py-1 text-right font-medium text-gray-500">kWh</th>
              <th className="px-2 py-1 text-left font-medium text-gray-500">Time</th>
              <th className="px-2 py-1 text-right font-medium text-gray-500">kWh</th>
              <th className="px-2 py-1 text-left font-medium text-gray-500">Time</th>
              <th className="px-2 py-1 text-right font-medium text-gray-500">kWh</th>
              <th className="px-2 py-1 text-left font-medium text-gray-500">Time</th>
              <th className="px-2 py-1 text-right font-medium text-gray-500">kWh</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 24 }, (_, row) => (
              <tr key={row} className="border-t hover:bg-gray-50">
                {[0, 1, 2, 3].map((col) => {
                  const i = row * 4 + col;
                  return (
                    <Fragment key={i}>
                      <td className="px-2 py-0.5 text-gray-500">
                        {slotLabel(i)}
                      </td>
                      <td className="px-2 py-0.5">
                        <input
                          type="number"
                          min={0}
                          step={0.1}
                          value={slots[i] ?? 0}
                          onChange={(e) => handleCellChange(i, e.target.value)}
                          className="w-16 rounded border px-1 py-0 text-right"
                        />
                      </td>
                    </Fragment>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
