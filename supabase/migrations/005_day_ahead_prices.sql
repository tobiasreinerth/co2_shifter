-- ── ENTSO-E day-ahead electricity prices (15-min slots, historical) ─────────
-- One row per (region, timestamp), parallel to co2_readings but for cost
-- instead of CO2. Populated by the ingest_day_ahead_prices_job Dagster job.
-- Not every bidding zone settles in EUR (e.g. SE/PL/RO/CZ/HU/BG use their
-- local currency) — currency is stored per row rather than assumed, and the
-- frontend must never convert between currencies (no FX data source).
create table day_ahead_prices (
  id          uuid primary key default gen_random_uuid(),
  region      text        not null,
  timestamp   timestamptz not null,   -- start of the 15-min slot (UTC)
  price       numeric     not null,   -- price per MWh, in `currency`
  currency    text        not null default 'EUR',
  source      text        not null default 'entsoe',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (region, timestamp)
);

create index day_ahead_prices_region_timestamp on day_ahead_prices (region, timestamp desc);

create trigger day_ahead_prices_set_updated_at
  before update on day_ahead_prices
  for each row
  execute function set_updated_at();

alter table day_ahead_prices enable row level security;

create policy "public read day_ahead_prices"
  on day_ahead_prices for select using (true);

-- ── Parameterized averaging window ──────────────────────────────────────────
-- Mirrors avg_intensity_by_slot(). currency is aggregated with max() rather
-- than grouped on — it's functionally dependent on region (a bidding zone's
-- settlement currency doesn't change day to day) but taking max() keeps the
-- function robust if that ever isn't true for a transition period.
create function avg_price_by_slot(p_region text, p_days int)
returns table (
  slot_index int,
  slot_time time,
  avg_price numeric,
  currency text,
  days_covered bigint
)
language sql
stable
as $$
  select
    (extract(hour from "timestamp" at time zone 'utc') * 4
     + extract(minute from "timestamp" at time zone 'utc') / 15)::int as slot_index,
    (("timestamp" at time zone 'utc')::time)                          as slot_time,
    round(avg(price), 2)                                              as avg_price,
    max(currency)                                                     as currency,
    count(distinct ("timestamp" at time zone 'utc')::date)            as days_covered
  from day_ahead_prices
  where region = p_region
    and "timestamp" >= (current_date - p_days)
    and "timestamp" < current_date
  group by 1, 2
  order by 1;
$$;
