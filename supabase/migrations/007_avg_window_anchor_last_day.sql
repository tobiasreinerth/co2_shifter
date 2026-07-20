-- ── Anchor averaging windows on the actual last-ingested day ────────────────
-- avg_intensity_by_slot() and avg_price_by_slot() previously anchored their
-- trailing window on the database's wall-clock current_date. If ingestion
-- has gaps or hasn't run yet for "today", days_covered silently comes back
-- lower than p_days with no indication why, and the window doesn't
-- necessarily end on the last day that actually has data. Anchor instead on
-- max(timestamp::date) per region - the actual last ingested day - and
-- return it as window_end_date so the frontend can show the real date
-- range covered instead of just a day count.
--
-- CREATE OR REPLACE FUNCTION cannot change a function's output column list,
-- so both functions are dropped and recreated rather than replaced in place.
drop function if exists avg_intensity_by_slot(text, int);

create function avg_intensity_by_slot(p_region text, p_days int)
returns table (
  slot_index int,
  slot_time time,
  avg_intensity_gco2_kwh numeric,
  avg_renewable_percentage numeric,
  days_covered bigint,
  window_end_date date   -- last UTC day with any co2_readings for p_region
)
language sql
stable
as $$
  with last_day as (
    select max(("timestamp" at time zone 'utc')::date) as d
    from co2_readings
    where region = p_region
  )
  select
    (extract(hour from cr."timestamp" at time zone 'utc') * 4
     + extract(minute from cr."timestamp" at time zone 'utc') / 15)::int as slot_index,
    ((cr."timestamp" at time zone 'utc')::time)                          as slot_time,
    round(avg(cr.intensity_gco2_kwh), 1)                                 as avg_intensity_gco2_kwh,
    round(avg(cr.renewable_percentage), 1)                               as avg_renewable_percentage,
    count(distinct (cr."timestamp" at time zone 'utc')::date)            as days_covered,
    max(last_day.d)                                                      as window_end_date
  from co2_readings cr
  cross join last_day
  where cr.region = p_region
    and cr."timestamp" >= (last_day.d - p_days + 1)
    and cr."timestamp" < (last_day.d + 1)
  group by 1, 2
  order by 1;
$$;

drop function if exists avg_price_by_slot(text, int);

-- Mirrors avg_intensity_by_slot(). currency is aggregated with max() rather
-- than grouped on - it's functionally dependent on region (a bidding zone's
-- settlement currency doesn't change day to day) but taking max() keeps the
-- function robust if that ever isn't true for a transition period.
create function avg_price_by_slot(p_region text, p_days int)
returns table (
  slot_index int,
  slot_time time,
  avg_price numeric,
  currency text,
  days_covered bigint,
  window_end_date date   -- last UTC day with any day_ahead_prices for p_region
)
language sql
stable
as $$
  with last_day as (
    select max(("timestamp" at time zone 'utc')::date) as d
    from day_ahead_prices
    where region = p_region
  )
  select
    (extract(hour from dap."timestamp" at time zone 'utc') * 4
     + extract(minute from dap."timestamp" at time zone 'utc') / 15)::int as slot_index,
    ((dap."timestamp" at time zone 'utc')::time)                          as slot_time,
    round(avg(dap.price), 2)                                              as avg_price,
    max(dap.currency)                                                     as currency,
    count(distinct (dap."timestamp" at time zone 'utc')::date)            as days_covered,
    max(last_day.d)                                                       as window_end_date
  from day_ahead_prices dap
  cross join last_day
  where dap.region = p_region
    and dap."timestamp" >= (last_day.d - p_days + 1)
    and dap."timestamp" < (last_day.d + 1)
  group by 1, 2
  order by 1;
$$;
