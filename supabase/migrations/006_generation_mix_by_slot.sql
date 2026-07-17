-- ── Rolling average generation mix, bucketed into 3 categories ──────────────
-- Powers the Step 2 stacked column chart: renewable / nuclear / fossil share
-- of generation per 15-min slot-of-day (UTC), averaged over a trailing
-- window. Mirrors avg_intensity_by_slot()'s window-parameter shape.
--
-- co2_readings.generation_mix is a JSONB map of source_name -> % share for
-- that single reading (ENTSO-E rows only; null for synthetic/Electricity
-- Maps rows, which this function silently skips). Each source is bucketed
-- via emission_factors: source_name = 'nuclear' -> nuclear; is_renewable
-- -> renewable; everything else (fossil fuels plus the "other"/"waste"
-- catch-alls) -> fossil.
create function avg_generation_mix_by_slot(p_region text, p_days int)
returns table (
  slot_index int,
  slot_time time,
  avg_renewable_percentage numeric,
  avg_nuclear_percentage numeric,
  avg_fossil_percentage numeric,
  days_covered bigint
)
language sql
stable
as $$
  with mix as (
    select
      cr.id,
      cr."timestamp",
      kv.key as source_name,
      kv.value::numeric as pct
    from co2_readings cr
    cross join lateral jsonb_each_text(cr.generation_mix) as kv(key, value)
    where cr.region = p_region
      and cr.generation_mix is not null
      and cr."timestamp" >= (current_date - p_days)
      and cr."timestamp" < current_date
  ),
  categorized as (
    select
      m.id,
      m."timestamp",
      case
        when ef.source_name = 'nuclear' then 'nuclear'
        when ef.is_renewable then 'renewable'
        else 'fossil'
      end as category,
      m.pct
    from mix m
    join emission_factors ef on ef.source_name = m.source_name
  ),
  per_row as (
    select
      id,
      "timestamp",
      sum(pct) filter (where category = 'renewable') as renewable_pct,
      sum(pct) filter (where category = 'nuclear')   as nuclear_pct,
      sum(pct) filter (where category = 'fossil')    as fossil_pct
    from categorized
    group by id, "timestamp"
  )
  select
    (extract(hour from "timestamp" at time zone 'utc') * 4
     + extract(minute from "timestamp" at time zone 'utc') / 15)::int as slot_index,
    (("timestamp" at time zone 'utc')::time)                          as slot_time,
    round(avg(coalesce(renewable_pct, 0)), 1) as avg_renewable_percentage,
    round(avg(coalesce(nuclear_pct, 0)), 1)   as avg_nuclear_percentage,
    round(avg(coalesce(fossil_pct, 0)), 1)    as avg_fossil_percentage,
    count(distinct ("timestamp" at time zone 'utc')::date) as days_covered
  from per_row
  group by 1, 2
  order by 1;
$$;
