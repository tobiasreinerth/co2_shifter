# CO2 Shifter

**Live demo:** https://frontend-phi-navy-16.vercel.app/dashboard

A B2B tool that shows industrial and commercial energy users how much CO2 (and money) they could save by shifting *when* they run their production — without using any more power.

## The idea

Electricity isn't uniformly clean or cheap throughout the day: the grid's generation mix (and therefore its carbon intensity and wholesale price) swings hour to hour with demand, weather, and what's currently online. A factory that can shift some of its load into cleaner or cheaper windows can cut emissions and its bill for free — no new equipment, just better timing.

You give the app your typical daily load profile (kWh consumed per 15-minute slot, 96 slots/day) and it tells you:

1. **How clean/expensive your grid actually is, hour by hour** — real historical data, not an estimate.
2. **How much shifting your schedule could save** — both against carbon intensity and against day-ahead price, calculated separately (the cheapest hours aren't always the cleanest ones).

The optimization itself is exact, not a heuristic: it searches every allowed time-shift and, for each one, solves the per-slot resizing exactly via a water-filling / fractional-knapsack algorithm — no generic LP solver needed, because the problem's structure (linear cost, box constraints, one energy-conservation constraint) admits a provably optimal greedy solution.

## Architecture

```
co2_shifter/
├── pipeline/      # Python + Dagster — pulls real grid data from ENTSO-E daily
├── supabase/      # Postgres schema + migrations (hosted on Supabase)
└── frontend/      # Next.js 15 + TypeScript — the dashboard (this is what users see)
```

Three simple stages, each doing one job:

| Stage | What it computes |
|---|---|
| **Pipeline** (Python) | Turns raw ENTSO-E generation data into *one* CO2 intensity number per 15-min slot: a generation-weighted mean of lifecycle emission factors (`Σ MWh × factor / total MWh`). Also fetches day-ahead prices. |
| **Database** (Postgres/SQL) | Rolls up history into trailing averages per slot-of-day (1 day / 4 weeks / 3 months), via a handful of `avg()` SQL functions. |
| **Frontend** (TypeScript, runs in the browser) | The actual optimization — brute-force search over candidate time-shifts, plus an exact water-filling solve per shift. This is the only place real "optimization math" happens, and it happens client-side, not on a server. |

## Tech stack

- **Pipeline**: Python, [Dagster](https://dagster.io) (scheduled + on-demand data ingestion), `httpx`, Pydantic
- **Data source**: [ENTSO-E Transparency Platform](https://transparency.entsoe.eu) — actual generation per production type (A75) and day-ahead auction prices (A44), across ~50 European bidding zones
- **Database**: [Supabase](https://supabase.com) (Postgres) — schema, RLS policies, and averaging functions live in `supabase/migrations/`
- **Frontend**: Next.js 15 (App Router), TypeScript, Tailwind CSS v4, Recharts — deployed on Vercel

## Getting started

### Pipeline (fetches grid data)
```bash
cd pipeline
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
export DAGSTER_HOME=$(pwd)/.dagster_home
dagster dev   # UI at http://localhost:3000
```
Trigger an ingest via the Dagster UI → Jobs → `ingest_entsoe_job`, config `{ "region": "DE", "fetch_date": "2024-06-01" }`. The daily schedule (06:00 UTC) only fires while `dagster dev` (or a Dagster daemon) is running.

### Frontend (the dashboard)
```bash
cd frontend
npm install
npm run dev   # http://localhost:3001/dashboard
```

### Database
```bash
supabase db push   # applies migrations in supabase/migrations/
```

Each of the three needs its own `.env` — see `pipeline/.env.example` and the Environment Variables section in `CLAUDE.md`.

## Where to go for more detail

This README is the quick overview. For a full technical breakdown — exact schema, every Dagster asset, every frontend component's behavior and rationale, engineering conventions, verification steps — see **[`CLAUDE.md`](./CLAUDE.md)**. It's written to onboard an AI coding assistant cold into this codebase each session, which in practice makes it the most complete and up-to-date technical reference in the repo — worth reading if you're onboarding as a human too.
