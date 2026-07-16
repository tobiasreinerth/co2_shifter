"""Tests for the daily ENTSO-E ingest schedule."""

from datetime import UTC, datetime

from dagster import RunRequest, build_schedule_context

from pipeline.assets.co2_intensity_entsoe import REGION_TO_EIC
from pipeline.schedules.daily_ingest import daily_entsoe_ingest_schedule


def test_daily_schedule_requests_every_region_for_last_two_days() -> None:
    ctx = build_schedule_context(
        scheduled_execution_time=datetime(2026, 7, 16, 6, 0, tzinfo=UTC)
    )

    requests = list(daily_entsoe_ingest_schedule(ctx))

    assert len(requests) == len(REGION_TO_EIC)
    assert all(isinstance(r, RunRequest) for r in requests)

    configs = {
        r.run_config["ops"]["co2_readings_entsoe"]["config"]["region"]: r for r in requests
    }
    assert set(configs) == set(REGION_TO_EIC)

    de_config = configs["DE"].run_config["ops"]["co2_readings_entsoe"]["config"]
    assert de_config["fetch_date"] == "2026-07-14"
    assert de_config["fetch_end_date"] == "2026-07-15"
    # Distinct run keys so Dagster can dedupe reruns of the same tick
    assert len({r.run_key for r in requests}) == len(requests)
