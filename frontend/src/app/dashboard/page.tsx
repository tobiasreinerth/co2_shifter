"use client";

import { useState } from "react";
import { Co2Chart } from "@/components/Co2Chart";
import { CostShiftCalculator } from "@/components/CostShiftCalculator";
import { EmissionFactorsChart } from "@/components/EmissionFactorsChart";
import { LoadProfileInput } from "@/components/LoadProfileInput";
import { PriceChart } from "@/components/PriceChart";
import { ShiftCalculator } from "@/components/ShiftCalculator";
import { REGIONS } from "@/lib/regions";
import { SLOTS_PER_DAY, type DataMode } from "@/lib/shift-calculator";
import type { LoadProfileSlots } from "@/types";

/** Small uppercase "Step N" eyebrow label, used to walk the reader through the page. */
function StepLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1 text-xs font-semibold tracking-wide text-gray-400 uppercase">
      {children}
    </p>
  );
}

/**
 * Dashboard: a single country selector, a single time-period selector
 * (owned by Co2Chart, lifted here), and a single load-profile input (lifted
 * here too) drive everything below the emission-factors reference chart -
 * the intensity chart, the price chart, and both the CO2 and cost shift
 * calculators always agree on which region, period, and schedule they're
 * looking at. The CO2 and cost optimizations remain two separate panels
 * with their own buttons and results - never combined into one number.
 * Copy throughout is written as a guided, four-step walkthrough for a
 * reader who knows their way around an electricity bill but isn't a power
 * systems engineer.
 */
export default function DashboardPage() {
  const [region, setRegion] = useState("DE");
  const [dataMode, setDataMode] = useState<DataMode>("latest");
  const [priceDataMode, setPriceDataMode] = useState<DataMode>("latest");
  const [loadSlots, setLoadSlots] = useState<LoadProfileSlots>(
    new Array(SLOTS_PER_DAY).fill(0)
  );

  return (
    <div className="space-y-10">
      <div>
        <h2 className="text-2xl font-semibold">Production Shift Optimization</h2>
        <p className="mt-2 max-w-2xl text-sm text-gray-600">
          Electricity price and carbon intensity both change hour to hour with what&apos;s running
          on the grid. If your production has any timing flexibility, shifting it to cleaner or
          cheaper hours can lower your emissions and electricity bill - without using any more
          power. Four steps: pick your grid region (country), explore its daily pattern, enter
          your schedule, see what shifting it could be worth.
        </p>
      </div>

      <div>
        <h3 className="mb-1 font-medium">Background: why timing matters</h3>
        <p className="mb-3 max-w-2xl text-sm text-gray-500">
          The grid blends many power sources at once, each with a very different carbon
          footprint per kWh. Coal and gas ramp up with demand; solar and wind depend on the
          weather. That mix - and how clean a kWh is - changes through the day. Here&apos;s the
          footprint behind each source.
        </p>
        <p className="mb-3 max-w-2xl text-sm text-gray-500">
          The same mix drives price too: abundant wind and solar push it down, since they cost
          little to run, while relying on gas or coal pushes it up. That&apos;s why cheap and clean
          hours often overlap - though not always, which is why we calculate both separately below.
        </p>
        <EmissionFactorsChart />
      </div>

      <div>
        <StepLabel>Step 1</StepLabel>
        <label className="flex max-w-xs flex-col gap-1 text-sm">
          <span className="font-medium text-gray-800">Choose your grid region</span>
          <select
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            className="rounded-md border px-3 py-2"
          >
            {REGIONS.map((r) => (
              <option key={r.code} value={r.code}>{r.label}</option>
            ))}
          </select>
        </label>
        <p className="mt-2 max-w-md text-xs text-gray-500">
          Prices and carbon intensity are set locally - let us know where your site is based,
          and we&apos;ll pull the right grid data.
        </p>
      </div>

      <div>
        <StepLabel>Step 2</StepLabel>
        <h3 className="mb-1 font-medium">See how your grid behaves over a typical day</h3>
        <p className="mb-4 max-w-2xl text-sm text-gray-500">
          Both CO2 emissions and electricity prices tend to follow a daily rhythm - higher at the
          morning and evening peaks, lower overnight and around midday when solar is strongest.
          Carbon intensity and price each have their own time-period selector below, so you can
          compare different windows.
        </p>
        <div className="space-y-6">
          <Co2Chart region={region} dataMode={dataMode} onDataModeChange={setDataMode} />
          <PriceChart region={region} dataMode={priceDataMode} onDataModeChange={setPriceDataMode} />
        </div>
      </div>

      <div>
        <StepLabel>Step 3</StepLabel>
        <h3 className="mb-1 font-medium">Tell us your production schedule</h3>
        <p className="mb-3 max-w-2xl text-sm text-gray-500">
          Only you know this: how much power your operation draws, slot by slot, across a
          typical day. Pick an example pattern to start (still fully editable), upload a CSV, or
          enter it by hand. We&apos;ll test this exact schedule below.
        </p>
        <LoadProfileInput slots={loadSlots} onChange={setLoadSlots} />
      </div>

      <div>
        <StepLabel>Step 4</StepLabel>
        <h3 className="mb-1 font-medium">See what shifting it could be worth</h3>
        <p className="mb-6 max-w-2xl text-sm text-gray-500">
          We run your schedule twice - once against carbon intensity, once against price - kept
          separate because the cheapest hours aren&apos;t always the cleanest ones.
        </p>

        <div className="space-y-8">
          <div>
            <StepLabel>Step 4a</StepLabel>
            <h4 className="mb-1 font-medium text-green-800">Reduce your carbon footprint</h4>
            <p className="mb-3 max-w-2xl text-sm text-gray-500">
              In kilograms of CO2 avoided for the day, based on your grid&apos;s carbon intensity.
            </p>
            <ShiftCalculator region={region} dataMode={dataMode} loadSlots={loadSlots} />
          </div>

          <div>
            <StepLabel>Step 4b</StepLabel>
            <h4 className="mb-1 font-medium text-blue-800">Lower your electricity bill</h4>
            <p className="mb-3 max-w-2xl text-sm text-gray-500">
              In your local currency, based on the day-ahead wholesale price.
            </p>
            <CostShiftCalculator region={region} dataMode={priceDataMode} loadSlots={loadSlots} />
          </div>
        </div>
      </div>
    </div>
  );
}
