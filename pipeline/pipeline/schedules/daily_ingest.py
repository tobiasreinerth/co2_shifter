"""Daily ENTSO-E ingest — keeps the rolling 91-day average window moving.

Runs at 06:00 UTC, once per supported region, ingesting yesterday plus
re-ingesting the day before: ENTSO-E publishes late corrections and fills
partial days over time, and the upsert on (region, timestamp) makes the
re-ingest idempotent. Only fires while a Dagster daemon (`dagster dev`)
is running.
"""

from collections.abc import Iterator
from datetime import timedelta

from dagster import DefaultScheduleStatus, RunRequest, ScheduleEvaluationContext, schedule

from pipeline.assets.co2_intensity_entsoe import REGION_TO_EIC
from pipeline.jobs.entsoe_job import ingest_entsoe_job


@schedule(
    cron_schedule="0 6 * * *",
    job=ingest_entsoe_job,
    execution_timezone="UTC",
    default_status=DefaultScheduleStatus.RUNNING,
)
def daily_entsoe_ingest_schedule(
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
                    "co2_readings_entsoe": {
                        "config": {
                            "region": region,
                            "fetch_date": day_before.isoformat(),
                            "fetch_end_date": yesterday.isoformat(),
                        }
                    }
                }
            },
        )
