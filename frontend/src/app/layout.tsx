import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CO2 Shifter",
  description: "Reduce your carbon footprint by shifting production to low-intensity windows",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50 text-gray-900 antialiased">
        <header className="border-b bg-white px-6 py-4">
          <h1 className="text-lg font-semibold tracking-tight">CO2 Shifter</h1>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
