-- ── Freshness tracking ────────────────────────────────────────────────────────
-- created_at only records the first insert; ingestion overwrites rows via
-- upsert (real data replacing synthetic, partial days filling in), so track
-- the last write separately.
alter table co2_readings
  add column updated_at timestamptz not null default now();

create function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger co2_readings_set_updated_at
  before update on co2_readings
  for each row
  execute function set_updated_at();

-- ── Rolling 91-day average intensity ──────────────────────────────────────────
-- Average per (region, 15-min slot-of-day, UTC) over the trailing 91 days
-- (13 weeks — every weekday appears exactly 13 times). Computed at read time:
-- each query reflects the current window; the daily ingest schedule is what
-- moves the window forward. days_covered exposes how much history backs a slot.
-- security_invoker: queries run with the caller's rights, so the public-read
-- RLS policy on co2_readings applies.
create view co2_readings_avg_91d
with (security_invoker = true)
as
select
  region,
  (extract(hour from "timestamp" at time zone 'utc') * 4
   + extract(minute from "timestamp" at time zone 'utc') / 15)::int as slot_index,
  round(avg(intensity_gco2_kwh), 1)   as avg_intensity_gco2_kwh,
  round(avg(renewable_percentage), 1) as avg_renewable_percentage,
  count(distinct ("timestamp" at time zone 'utc')::date) as days_covered
from co2_readings
where "timestamp" >= (current_date - interval '91 days')
  and "timestamp" < current_date
group by 1, 2;
