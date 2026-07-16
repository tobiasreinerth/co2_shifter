/**
 * Ready-made 96-slot load profiles so users don't have to fill the table by
 * hand. Each is a characteristic industrial consumption pattern; applying one
 * fills the editable table, where every value can still be tweaked.
 */
import { SLOTS_PER_DAY } from "./shift-calculator";

export interface ExampleProfile {
  id: string;
  name: string;
  description: string;
  slots: number[]; // kWh per 15-min slot, 96 entries
}

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
  return Array.from({ length: SLOTS_PER_DAY }, (_, i) =>
    Math.round(fn(i / 4) * 10) / 10
  );
}

export const EXAMPLE_PROFILES: ExampleProfile[] = [
  {
    id: "continuous",
    name: "Continuous process",
    description: "Flat 20 kWh around the clock — cold storage, data center, base chemical load.",
    slots: generate(() => 20),
  },
  {
    id: "day-shift",
    name: "Single day shift",
    description: "Flat 60 kWh block 08:00–16:00, small standby load otherwise.",
    slots: generate((h) => (h >= 8 && h < 16 ? 60 : 4)),
  },
  {
    id: "two-peaks",
    name: "Day shift with lunch dip",
    description:
      "Smooth morning ramp-up, peaks before and after lunch, dip over the break, evening ramp-down.",
    slots: generate((h) => {
      const plateau = 35 * (smoothstep(6, 9, h) - smoothstep(16.5, 20, h));
      const peaks = 12 * bump(h, 10.75, 0.8) + 12 * bump(h, 14.5, 0.8);
      const lunchDip = -18 * bump(h, 12.5, 0.5);
      return Math.max(5, 5 + plateau + peaks + lunchDip);
    }),
  },
  {
    id: "night-shift",
    name: "Night operation",
    description: "Runs 22:00–06:00 (off-peak tariffs), minimal daytime load.",
    slots: generate(
      (h) => 6 + 40 * (1 - (smoothstep(5, 7, h) - smoothstep(21, 23, h)))
    ),
  },
];
