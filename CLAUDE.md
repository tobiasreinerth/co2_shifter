# CO2 Shifter

B2B app that helps companies reduce carbon emissions by shifting their production schedule to low-carbon windows. Companies input their typical energy consumption per 15-min slot; the app shows how much CO2 they save by shifting the entire day's load earlier or later.

## Architecture

```
co2_shifter/
├── pipeline/      # Dagster — fetches historical 15-min CO2 intensity data on demand
├── frontend/      # Next.js 15 (App Router) + TypeScript — B2B dashboard
└── supabase/      # DB migrations and schema
```

## Core Concept

A typical day has **96 × 15-min slots** (00:00–23:45).

- **Load profile**: the company's kWh consumed per slot — entered manually or via CSV upload.
- **Intensity profile**: gCO2eq/kWh emitted from the grid per slot for a given date and region.
- **Shift analysis**: try all circular shifts (−12 h … +12 h) of the load profile against the intensity profile to find the minimum total daily CO2.

```
savings_gCO2 = Σ load[i] * intensity[(i + shift) % 96]  for shift in [−48, +48]
```

The result is a bar chart showing total daily CO2 for every possible shift, highlighting the current schedule and the optimal shift.

## Stack

- **Data pipeline**: Python + Dagster, run on-demand (no polling schedule)
- **CO2 API**: Electricity Maps — `api.electricitymaps.com/v3/carbon-intensity/history`
- **Database**: Supabase (Postgres) — `supabase-py` in pipeline, `@supabase/supabase-js` in frontend
- **Frontend**: Next.js 15 App Router, TypeScript, Tailwind CSS v4, Recharts

## Dev Setup

### Pipeline
```bash
cd pipeline
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
dagster dev          # Dagster UI at http://localhost:3000
```

Trigger a data ingest via the Dagster UI → Jobs → `ingest_co2_job`, passing config:
```json
{ "region": "DE", "fetch_date": "2024-06-01" }
```

### Frontend
```bash
cd frontend
npm install
npm run dev          # http://localhost:3001
```

### Supabase
```bash
supabase start       # local dev stack
supabase db push     # apply migrations
```

## Environment Variables

### pipeline/.env
```
ELECTRICITY_MAPS_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

### frontend/.env.local
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

## Database Schema

See `supabase/migrations/001_initial_schema.sql`.

| Table | Purpose |
|---|---|
| `co2_readings` | 15-min CO2 intensity rows per (region, timestamp) |
| `companies` | B2B tenant records |
| `load_profiles` | Named load profiles per company |
| `load_profile_slots` | 96 rows per profile — kWh per 15-min slot |
| `shift_analyses` | Saved analysis results |

## Dagster Asset

`co2_readings_daily` — given `{region, fetch_date}`, fetches ~96 slots from Electricity Maps history endpoint and upserts into `co2_readings`. No schedule — triggered manually or via external automation.

## Frontend Components

- `Co2Chart` — shows a full day's 15-min intensity + renewable % as a ComposedChart
- `LoadProfileInput` — 96-cell editable table + CSV upload
- `ShiftCalculator` — wires everything together; calls `analyzeShifts()` and renders the shift bar chart

## Conventions

- Pipeline: type hints everywhere, Pydantic models for API responses
- Frontend: server components by default, `use client` only where needed
- Timestamps always UTC, stored as `timestamptz`
- Shift math is circular (wraps midnight) — load profile is treated as a repeating daily pattern
