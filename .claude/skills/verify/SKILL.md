---
name: verify
description: How to run and verify CO2 Shifter end-to-end — frontend via Playwright against the dev server, pipeline via dagster job execute, database via Supabase REST.
---

# Verifying CO2 Shifter

Three surfaces; all talk to the **hosted** Supabase project (no local stack — Docker is broken on this machine).

## Frontend (Next.js dashboard)

```bash
cd frontend && npm run dev        # http://localhost:3001 — check first, one may already be running
```

Drive with Playwright headless from the scratchpad (`npm i playwright`, chromium usually cached in ~/Library/Caches/ms-playwright). Gotchas:

- The dashboard page renders **Co2Chart first, then ShiftCalculator** — selects on the page are `[0]` chart region, `[1]` calculator region, `[2]` calculator grid-data mode; date inputs `[0]` chart, `[1]` calculator (hidden in average mode).
- Load a profile via the hidden file input: `setInputFiles` with a 96-line CSV buffer (one kWh value per line).
- Click "Compute optimal shift", wait for `text=CO2 savings`.
- Recharts animates bars in — `waitForTimeout(500)` before screenshots or the shift chart looks empty.
- Text like "Optimal shift" appears in 3 elements; use `getByText(/^Optimal shift \(/)` + `following-sibling::p` for the stat value.

## Pipeline (Dagster)

```bash
cd pipeline && source .venv/bin/activate
dagster job execute -m pipeline.definitions -j ingest_entsoe_job --config cfg.yaml
```

- `-m pipeline.definitions` is required (the pyproject `[tool.dagster]` hint is not picked up by `job execute`).
- No `--config-json` on this setup — write a YAML file: `ops.co2_readings_entsoe.config.{region,fetch_date,fetch_end_date}`.
- `.env` in `pipeline/` is loaded automatically (real ENTSO-E + Supabase credentials).
- A 91-day single-region backfill takes ~3–4 min; run multi-region loops in the background.

## Database

Query via REST with the service key (no psql; migrations via `npx -y supabase@latest db push --db-url "$SUPABASE_DB_URL"` — URL is in `pipeline/.env`, prompt auto-confirms with `echo Y |`):

```bash
set -a && source pipeline/.env && set +a
curl -s "$SUPABASE_URL/rest/v1/co2_readings_avg_91d?region=eq.DE&limit=3" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

## Flows worth driving

- Average mode (default): compute → coverage note "…N days of grid data available", stats, bar chart.
- Specific-date mode: pick an ingested date (2026-07-14 onward) → result; un-ingested date → friendly red error.
- Ingest: run `ingest_entsoe_job` for a recent day; failed/no-data days surface in the Dagster run log (`Skipping …` / red run with ENTSO-E's reason).
