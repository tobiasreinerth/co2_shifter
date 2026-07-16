-- ── Parameterized averaging window ────────────────────────────────────────────
-- The calculator offers "last 7 days / 4 weeks / 3 months" — one function
-- instead of a view per window. Runs with the caller's rights (RLS applies;
-- co2_readings is public-read). The co2_readings_avg_91d view stays for
-- manual inspection.
create function avg_intensity_by_slot(p_region text, p_days int)
returns table (
  slot_index int,
  slot_time time,
  avg_intensity_gco2_kwh numeric,
  avg_renewable_percentage numeric,
  days_covered bigint
)
language sql
stable
as $$
  select
    (extract(hour from "timestamp" at time zone 'utc') * 4
     + extract(minute from "timestamp" at time zone 'utc') / 15)::int as slot_index,
    (("timestamp" at time zone 'utc')::time)                          as slot_time,
    round(avg(intensity_gco2_kwh), 1)                                 as avg_intensity_gco2_kwh,
    round(avg(renewable_percentage), 1)                               as avg_renewable_percentage,
    count(distinct ("timestamp" at time zone 'utc')::date)            as days_covered
  from co2_readings
  where region = p_region
    and "timestamp" >= (current_date - p_days)
    and "timestamp" < current_date
  group by 1, 2
  order by 1;
$$;
