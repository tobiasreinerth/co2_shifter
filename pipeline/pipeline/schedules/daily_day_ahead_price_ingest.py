"""Daily ENTSO-E day-ahead price ingest — keeps the rolling average window moving.

Runs at 06:00 UTC, once per supported region, ingesting yesterday plus
re-ingesting the day before. Day-ahead prices for day D are published on
D-1, so by the time this runs, both days already have finalized prices —
the same trailing-2-day window used for the CO2 intensity schedule applies
unchanged (no forward-looking window needed). Only fires while a Dagster
daemon (`dagster dev`) is running.
"""

from collections.abc import Iterator
from datetime import timedelta

from dagster import RunRequest, ScheduleEvaluationContext, schedule

from pipeline.entsoe_regions import REGION_TO_EIC
from pipeline.jobs.day_ahead_price_job import ingest_day_ahead_prices_job


@schedule(
    cron_schedule="0 6 * * *",
    job=ingest_day_ahead_prices_job,
    execution_timezone="UTC",
)
def daily_day_ahead_price_schedule(
    context: ScheduleEvaluationContext,
) -> Iterator[RunRequest]:
    """Yields one ingest run per region covering the last two full days."""
    yesterday = context.scheduled_execution_time.date() - timedelta(days=1)
    day_before = yesterday - timedelta(days=1)

    for region in REGION_TO_EIC:
        yield RunRequest(
            run_key=f"{region}-{yesterday.isoformat()}",
            run_config={
                "ops": {
                    "day_ahead_prices_entsoe": {
                        "config": {
                            "region": region,
                            "fetch_date": day_before.isoformat(),
                            "fetch_end_date": yesterday.isoformat(),
                        }
                    }
                }
            },
        )
