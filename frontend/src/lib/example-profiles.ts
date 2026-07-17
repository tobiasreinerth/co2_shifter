/**
 * Ready-made 96-slot load profiles so users don't have to fill the table by
 * hand. Each is a characteristic industrial consumption pattern; applying one
 * fills the editable table, where every value can still be tweaked. Every
 * profile is normalized to the same daily total (DAILY_TOTAL_KWH) so they're
 * directly comparable, and none is perfectly flat - optimizeBoundedReshape()
 * has zero headroom to work with when a slot's historical max equals its
 * min, so a flat profile can never show a reshape saving.
 */
import { SLOTS_PER_DAY } from "./shift-calculator";

export interface ExampleProfile {
  id: string;
  name: string;
  description: string;
  slots: number[]; // kWh per 15-min slot, 96 entries
}

/** Shared daily total (2 MWh) so all example profiles are directly comparable. */
export const DAILY_TOTAL_KWH = 2000;

/** Hermite smoothstep: 0 below a, 1 above b, smooth S-curve in between. */
function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Gaussian bump centered at `center` (hours) with width sigma (hours). */
function bump(h: number, center: number, sigma: number): number {
  return Math.exp(-((h - center) ** 2) / (2 * sigma ** 2));
}

function generate(fn: (hour: number) => number): number[] {
  return Array.from({ length: SLOTS_PER_DAY }, (_, i) => fn(i / 4));
}

/** Rescales a raw shape to sum to DAILY_TOTAL_KWH, so every example profile is comparable. */
function normalize(raw: number[]): number[] {
  const sum = raw.reduce((s, v) => s + v, 0);
  const factor = DAILY_TOTAL_KWH / sum;
  return raw.map((v) => Math.round(v * factor * 10) / 10);
}

export const EXAMPLE_PROFILES: ExampleProfile[] = [
  {
    id: "continuous",
    name: "Near-continuous process",
    description:
      "Cold storage, data center, or base chemical load - runs around the clock with a mild daytime rise.",
    slots: normalize(generate((h) => 16 + 6 * (smoothstep(7, 10, h) - smoothstep(19, 22, h)))),
  },
  {
    id: "day-shift",
    name: "Single day shift",
    description: "One 8-hour shift, 08:00-16:00, with a small standby load the rest of the day.",
    slots: normalize(generate((h) => (h >= 8 && h < 16 ? 60 : 4))),
  },
  {
    id: "two-shift",
    name: "Two-shift operation",
    description:
      "Two back-to-back 8-hour shifts, roughly 06:00-22:00, with a brief dip at the changeover and a quiet overnight.",
    slots: normalize(
      generate((h) => {
        const shift1 = smoothstep(6, 6.5, h) - smoothstep(13.5, 14, h);
        const shift2 = smoothstep(14, 14.5, h) - smoothstep(21.5, 22, h);
        const daytimeFloor = h >= 5.5 && h <= 22.5 ? 15 : 3;
        return daytimeFloor + 30 * (shift1 + shift2);
      })
    ),
  },
  {
    id: "two-peaks",
    name: "Day shift with lunch dip",
    description:
      "Smooth morning ramp-up, peaks before and after lunch, dip over the break, evening ramp-down.",
    slots: normalize(
      generate((h) => {
        const plateau = 35 * (smoothstep(6, 9, h) - smoothstep(16.5, 20, h));
        const peaks = 12 * bump(h, 10.75, 0.8) + 12 * bump(h, 14.5, 0.8);
        const lunchDip = -18 * bump(h, 12.5, 0.5);
        return Math.max(5, 5 + plateau + peaks + lunchDip);
      })
    ),
  },
];
