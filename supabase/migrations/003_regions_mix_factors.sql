-- ── Per-source generation mix ─────────────────────────────────────────────────
-- Share of generation per source for the slot, e.g. {"solar": 20.1, "fossil_gas": 34.2}.
-- Percentages of total generation; zero-share sources omitted. Only populated
-- by the ENTSO-E asset (synthetic/Electricity Maps rows stay null).
alter table co2_readings
  add column generation_mix jsonb;

-- ── Emission factors (source of truth) ────────────────────────────────────────
-- The pipeline reads this table at the start of every ingest run — edit a
-- factor here and the next ingest uses it (already-stored rows keep the values
-- they were computed with; re-run the backfill to recompute history).
-- psr_type is the ENTSO-E production source code (B01–B20).
create table emission_factors (
  psr_type               text primary key,
  source_name            text        not null,   -- readable key, matches generation_mix keys
  factor_gco2eq_per_kwh  numeric     not null check (factor_gco2eq_per_kwh > 0),
  is_renewable           boolean     not null,
  citation               text        not null,
  updated_at             timestamptz not null default now()
);

create trigger emission_factors_set_updated_at
  before update on emission_factors
  for each row
  execute function set_updated_at();

alter table emission_factors enable row level security;
create policy "public read emission_factors"
  on emission_factors for select using (true);

-- Lifecycle emission factors (gCO2eq/kWh).
-- IPCC AR5 = IPCC Fifth Assessment Report (2014), WGIII Annex III, Table A.III.2,
-- median lifecycle emissions per technology. Electricity Maps defaults cover
-- types IPCC does not list (github.com/electricitymaps/electricitymaps-contrib).
insert into emission_factors (psr_type, source_name, factor_gco2eq_per_kwh, is_renewable, citation) values
  ('B01', 'biomass',                  230, true,  'IPCC AR5 WGIII Annex III Tbl A.III.2 (dedicated biomass, median)'),
  ('B02', 'fossil_brown_coal_lignite',820, false, 'IPCC AR5 WGIII Annex III Tbl A.III.2 (coal median; DE lignite plants run higher)'),
  ('B03', 'fossil_coal_derived_gas',  490, false, 'IPCC AR5 gas median applied as proxy for coal-derived gas'),
  ('B04', 'fossil_gas',               490, false, 'IPCC AR5 WGIII Annex III Tbl A.III.2 (combined-cycle gas, median)'),
  ('B05', 'fossil_hard_coal',         820, false, 'IPCC AR5 WGIII Annex III Tbl A.III.2 (coal, median)'),
  ('B06', 'fossil_oil',               650, false, 'Electricity Maps default (oil; IPCC AR5 lists no oil median)'),
  ('B07', 'fossil_oil_shale',         820, false, 'Coal median applied as proxy (Electricity Maps convention)'),
  ('B08', 'fossil_peat',              820, false, 'Coal median applied as proxy (Electricity Maps convention)'),
  ('B09', 'geothermal',                38, true,  'IPCC AR5 WGIII Annex III Tbl A.III.2 (geothermal, median)'),
  ('B10', 'hydro_pumped_storage',      24, true,  'IPCC AR5 hydro median; NAIVE — ignores round-trip storage losses'),
  ('B11', 'hydro_run_of_river',        24, true,  'IPCC AR5 WGIII Annex III Tbl A.III.2 (hydro, median)'),
  ('B12', 'hydro_water_reservoir',     24, true,  'IPCC AR5 WGIII Annex III Tbl A.III.2 (hydro, median)'),
  ('B13', 'marine',                    17, true,  'IPCC AR5 WGIII Annex III Tbl A.III.2 (ocean, median)'),
  ('B14', 'nuclear',                   12, false, 'IPCC AR5 WGIII Annex III Tbl A.III.2 (nuclear, median)'),
  ('B15', 'other_renewable',           38, true,  'Geothermal median applied as conservative proxy'),
  ('B16', 'solar',                     45, true,  'IPCC AR5 WGIII Annex III Tbl A.III.2 (PV; between utility 48 / rooftop 41)'),
  ('B17', 'waste',                    700, false, 'Electricity Maps default (waste incineration)'),
  ('B18', 'wind_offshore',             12, true,  'IPCC AR5 WGIII Annex III Tbl A.III.2 (wind offshore, median)'),
  ('B19', 'wind_onshore',              11, true,  'IPCC AR5 WGIII Annex III Tbl A.III.2 (wind onshore, median)'),
  ('B20', 'other',                    700, false, 'Electricity Maps default (unknown/other; also the fallback for unmapped types)');

-- ── Readable slot time in the rolling-average view ────────────────────────────
-- Adds slot_time (start of the 15-min window, UTC) alongside slot_index so the
-- view is easy to eyeball; the frontend keeps using slot_index.
-- Drop + recreate: "create or replace view" cannot insert a column mid-list.
drop view co2_readings_avg_91d;
create view co2_readings_avg_91d
with (security_invoker = true)
as
select
  region,
  (extract(hour from "timestamp" at time zone 'utc') * 4
   + extract(minute from "timestamp" at time zone 'utc') / 15)::int as slot_index,
  (("timestamp" at time zone 'utc')::time) as slot_time,
  round(avg(intensity_gco2_kwh), 1)   as avg_intensity_gco2_kwh,
  round(avg(renewable_percentage), 1) as avg_renewable_percentage,
  count(distinct ("timestamp" at time zone 'utc')::date) as days_covered
from co2_readings
where "timestamp" >= (current_date - interval '91 days')
  and "timestamp" < current_date
group by 1, 2, 3;
