-- Enable UUID generation
create extension if not exists "pgcrypto";

-- ── CO2 intensity readings (15-min slots, historical) ────────────────────────
-- One row per (region, timestamp). Populated by the Dagster ingest job.
create table co2_readings (
  id                    uuid primary key default gen_random_uuid(),
  region                text        not null,   -- e.g. "DE", "FR", "GB"
  timestamp             timestamptz not null,   -- start of the 15-min slot (UTC)
  intensity_gco2_kwh    numeric     not null,   -- gCO2eq / kWh
  renewable_percentage  numeric,                -- % of generation from renewables
  source                text        not null default 'electricitymaps',
  created_at            timestamptz not null default now(),

  unique (region, timestamp)
);

create index co2_readings_region_timestamp on co2_readings (region, timestamp desc);

-- ── B2B companies ─────────────────────────────────────────────────────────────
create table companies (
  id         uuid primary key default gen_random_uuid(),
  name       text        not null,
  region     text        not null,   -- default grid region for this company
  created_at timestamptz not null default now()
);

-- ── Load profiles ─────────────────────────────────────────────────────────────
-- A load profile represents a typical day: 96 × 15-min energy consumption slots.
create table load_profiles (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid references companies (id) on delete cascade,
  name        text        not null,        -- e.g. "Standard production day"
  region      text        not null,
  created_at  timestamptz not null default now()
);

-- One row per 15-min slot (slot_index 0 = 00:00, 95 = 23:45)
create table load_profile_slots (
  id              uuid primary key default gen_random_uuid(),
  profile_id      uuid not null references load_profiles (id) on delete cascade,
  slot_index      smallint not null check (slot_index >= 0 and slot_index < 96),
  kwh_consumed    numeric  not null check (kwh_consumed >= 0),

  unique (profile_id, slot_index)
);

create index load_profile_slots_profile on load_profile_slots (profile_id, slot_index);

-- ── Saved shift analyses ──────────────────────────────────────────────────────
create table shift_analyses (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid references companies (id) on delete set null,
  profile_id       uuid references load_profiles (id) on delete set null,
  region           text        not null,
  analysis_date    date        not null,   -- the day whose intensity data is used

  -- Shift expressed as number of 15-min slots (negative = earlier, positive = later)
  -- 0 = no shift (baseline)
  shift_slots      smallint    not null default 0,

  -- Computed totals (gCO2)
  baseline_co2_g   numeric,
  shifted_co2_g    numeric,
  savings_co2_g    numeric,    -- positive = savings

  created_at       timestamptz not null default now()
);

-- ── Row-level security ────────────────────────────────────────────────────────
alter table co2_readings         enable row level security;
alter table companies            enable row level security;
alter table load_profiles        enable row level security;
alter table load_profile_slots   enable row level security;
alter table shift_analyses       enable row level security;

-- CO2 intensity data is publicly readable (no auth required)
create policy "public read co2_readings"
  on co2_readings for select using (true);
