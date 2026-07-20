"""Dagster entry point: wires assets, jobs, and env-configured resources."""

from dagster import Definitions, EnvVar

from pipeline.assets.co2_intensity_entsoe import co2_readings_entsoe
from pipeline.assets.day_ahead_prices_entsoe import day_ahead_prices_entsoe
from pipeline.jobs.day_ahead_price_job import ingest_day_ahead_prices_job
from pipeline.jobs.entsoe_job import ingest_entsoe_job
from pipeline.resources.api_key_resource import ApiKeyResource
from pipeline.resources.supabase_resource import SupabaseResource
from pipeline.schedules.daily_day_ahead_price_ingest import daily_day_ahead_price_schedule
from pipeline.schedules.daily_ingest import daily_entsoe_ingest_schedule

defs = Definitions(
    assets=[
        co2_readings_entsoe,
        day_ahead_prices_entsoe,
    ],
    jobs=[ingest_entsoe_job, ingest_day_ahead_prices_job],
    # Fires only while the Dagster daemon (`dagster dev`) is running
    schedules=[daily_entsoe_ingest_schedule, daily_day_ahead_price_schedule],
    resources={
        "supabase": SupabaseResource(
            url=EnvVar("SUPABASE_URL"),
            service_role_key=EnvVar("SUPABASE_SERVICE_ROLE_KEY"),
        ),
        "entsoe_api_key": ApiKeyResource(key=EnvVar("ENTSOE_API_KEY")),
    },
)
