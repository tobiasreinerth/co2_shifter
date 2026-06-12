import Link from "next/link";

export default function Home() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Reduce your carbon footprint</h2>
        <p className="mt-2 text-gray-600">
          See how much CO2 you can save by shifting your production to
          low-carbon windows.
        </p>
      </div>
      <Link
        href="/dashboard"
        className="inline-block rounded-lg bg-green-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-green-700"
      >
        Open dashboard
      </Link>
    </div>
  );
}
