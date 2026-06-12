import { ShiftCalculator } from "@/components/ShiftCalculator";
import { Co2Chart } from "@/components/Co2Chart";

export default function DashboardPage() {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold">Shift Calculator</h2>
        <p className="mt-1 text-sm text-gray-500">
          Enter your load and time windows to estimate CO2 savings.
        </p>
      </div>
      <Co2Chart />
      <ShiftCalculator />
    </div>
  );
}
