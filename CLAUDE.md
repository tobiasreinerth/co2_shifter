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

- **Data pipeline**: Python + Dagster — daily schedule at 06:00 UTC (needs a running Dagster daemon) plus on-demand runs/backfills
- **CO2 API (primary)**: ENTSO-E Transparency Platform — `web-api.tp.entsoe.eu/api`, documentType A75 (actual generation per type); intensity derived as generation-weighted mean of lifecycle emission factors (production-based, ignores imports/exports)
- **CO2 API (legacy/alternative)**: Electricity Maps — `api.electricitymaps.com/v3/carbon-intensity/history`
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
ENTSOE_API_KEY=
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
| `co2_readings` | 15-min CO2 intensity rows per (region, timestamp); `generation_mix` JSONB = share % per source (ENTSO-E rows only); `created_at` = first insert, `updated_at` = last upsert (trigger) |
| `co2_readings_avg_91d` | View: rolling 91-day average intensity per (region, UTC slot-of-day, `slot_time`) — kept for manual inspection |
| `avg_intensity_by_slot(region, days)` | Function the frontend calls: average intensity per UTC slot-of-day over a trailing window (7/28/91 days in the UI) |
| `emission_factors` | **Source of truth** for lifecycle gCO2eq/kWh per ENTSO-E PSR type, with citations (IPCC AR5 / Electricity Maps); the pipeline loads it every run — edit a factor there and the next ingest uses it (re-run backfill to recompute history) |
| `companies` | B2B tenant records |
| `load_profiles` | Named load profiles per company |
| `load_profile_slots` | 96 rows per profile — kWh per 15-min slot |
| `shift_analyses` | Saved analysis results |

## Dagster Assets

All upsert into `co2_readings` on `(region, timestamp)`. Config: `{region, fetch_date}`; the ENTSO-E asset also takes an optional `fetch_end_date` for inclusive-range backfills — ranges are fetched in ≤31-day chunks (one A75 request + one bulk upsert per chunk); unpublished chunks are skipped with a warning and the run fails only if no chunk yields data.

- `co2_readings_entsoe` (job `ingest_entsoe_job`) — fetches actual generation per production type from ENTSO-E (A75) and derives 15-min production-based CO2 intensity plus the per-source `generation_mix`. Emission factors come from the `emission_factors` table (loaded each run). Regions: ~50 bidding zones (`REGION_TO_EIC` in the asset; multi-zone countries DK/NO/SE/IT appear per zone; GB unavailable — stopped publishing to ENTSO-E post-Brexit). `daily_entsoe_ingest_schedule` runs it at 06:00 UTC per region for the last two full days (idempotent re-ingest catches ENTSO-E's late corrections) — only while a Dagster daemon runs.
- `co2_readings_synthetic` (job `seed_co2_job`) — hardcoded stylized curve, dev/demo placeholder; real data overwrites it for the same day.
- `co2_readings_daily` (job `ingest_co2_job`) — legacy Electricity Maps history fetch.

## Frontend Components

- Dashboard page (`app/dashboard/page.tsx`) order: `EmissionFactorsChart` (global, not region-specific — shown first) → region/country selector (default `DE`) → `Co2Chart` → `ShiftCalculator`. `region` and `dataMode` (`DataMode` = `"latest" | "avg30" | "avg91"`, owned by the page, surfaced via `Co2Chart`'s own select) are both lifted to the page and passed down as props — `Co2Chart` and `ShiftCalculator` never own this state themselves, so they can never disagree about which region/period is active. The single fetch path both pull from is `fetchIntensityCurve(region, mode)` in `lib/shift-calculator.ts` (returns `{ intensitySlots, renewableSlots, label, coverageDays }` or `null`); shared select labels live in `DATA_MODE_LABELS`.
- `EmissionFactorsChart` — reference chart of ENTSO-E production sources' lifecycle gCO2eq/kWh (from `emission_factors`), sorted highest-intensity first, 🍃 marking renewable sources. Sources sharing an identical factor *and* renewable status are grouped into one bar (e.g. the 4 fossil sources tied at 820 g/kWh) — grouping keys on both fields since Nuclear and Wind Offshore tie at 12 g/kWh but must stay visually separate. Grouped bars' tooltips list every constituent source with its own citation.
- `Co2Chart` — 96-slot intensity line (black) + renewable-% bar (dark green) as a ComposedChart, visible grid lines; the mode select offers "Latest available day" (resolves to the most recent date actually ingested, shown in a caption — not necessarily yesterday) / "1-month average" / "3-month average" — no arbitrary date picker.
- `LoadProfileInput` — 96-cell editable table + CSV upload, plus 4 example-profile cards (`lib/example-profiles.ts`: continuous, single day shift, day shift with lunch dip, night operation) with inline sparkline previews — clicking one fills the table, still editable after.
- `ShiftCalculator` — no longer has its own time-period selector; consumes the dashboard's `dataMode` (shown as a note: "Uses the time period selected in the CO2 Intensity chart above"). Optimization is a pair of always-visible description cards (not a hidden-until-selected dropdown): **Rigid shift** (`analyzeShifts()` — slides the whole day as one block, ±12h, shape unchanged) and **Bounded reshaping** (`optimizeBoundedReshape()` — each slot moves ≤ a user-chosen max shift (30/60/120 min) and rescales ≤ a user-chosen magnitude band (10/20/30%), clipped to the profile's historical max/non-zero-min, total daily energy conserved exactly via a cheapest-slot-first water-filling allocation — the exact optimum for this box-constrained linear-cost problem, not a heuristic). Both modes render through one shared result view: original schedule (black line), optimized schedule (dark green line), and the period's grid CO2 intensity per slot (grey bars on a compressed secondary axis, deliberately smaller than the load curves).

## Conventions

- Pipeline: type hints everywhere, Pydantic models for API responses
- Frontend: server components by default, `use client` only where needed
- Timestamps always UTC, stored as `timestamptz`
- Shift math is circular (wraps midnight) — load profile is treated as a repeating daily pattern

## Engineering Standards

These apply to all code changes, in every session.

### Python (pipeline)
- **Type hints on every function** — parameters and return types, including tests and private helpers. `mypy` is configured strict in `pyproject.toml`.
- **Docstrings on every function and class** — one line minimum; explain the *why* and non-obvious behavior (e.g. API quirks), not a restatement of the name.
- **No `print()`** — use `context.log` inside Dagster assets/ops, the stdlib `logging` module elsewhere.
- **Error handling on every external call** (ENTSO-E, Electricity Maps, Supabase):
  - HTTP errors must include the response body snippet — both APIs put the real reason in the body, not the status line.
  - ENTSO-E answers HTTP 200 with an `Acknowledgement_MarketDocument` when there is no data — check via `raise_if_acknowledgement()` before parsing.
  - Supabase writes go through `SupabaseResource.upsert_co2_readings()`, which wraps errors in `dagster.Failure` with detail. Don't call `.table(...).upsert(...)` directly from assets.
  - Assets fail loudly (`dagster.Failure` with an actionable description) — never swallow errors and continue with partial data.
- **Every Dagster asset has pytest coverage** — pure logic (parsing, computation) tested directly; the asset function tested via `build_asset_context()` with mocked resources (`MagicMock` for Supabase, monkeypatched fetch functions — tests never hit the network).
- **Ruff must pass before commit**: `ruff check pipeline tests` from `pipeline/` (rules `E, F, I, UP`, line length 100).

### TypeScript (frontend)
- **JSDoc on every exported component and function**, plus non-trivial private helpers — one line is fine for small helpers.
- `npx tsc --noEmit` must pass before commit.

### Verification before commit
```bash
cd pipeline && ruff check pipeline tests && python -m pytest tests/ -q
cd frontend && npx tsc --noEmit
```
