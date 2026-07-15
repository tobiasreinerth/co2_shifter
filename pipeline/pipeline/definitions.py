from dagster import Definitions, EnvVar

from pipeline.assets.co2_intensity import co2_readings_daily
from pipeline.assets.co2_intensity_entsoe import co2_readings_entsoe
from pipeline.assets.co2_intensity_synthetic import co2_readings_synthetic
from pipeline.jobs.entsoe_job import ingest_entsoe_job
from pipeline.jobs.ingest_job import ingest_co2_job
from pipeline.jobs.seed_job import seed_co2_job
from pipeline.resources.api_key_resource import ApiKeyResource
from pipeline.resources.supabase_resource import SupabaseResource

defs = Definitions(
    assets=[co2_readings_daily, co2_readings_entsoe, co2_readings_synthetic],
    jobs=[ingest_co2_job, ingest_entsoe_job, seed_co2_job],
    # No schedule — jobs are triggered manually (or via external orchestration)
    resources={
        "supabase": SupabaseResource(
            url=EnvVar("SUPABASE_URL"),
            service_role_key=EnvVar("SUPABASE_SERVICE_ROLE_KEY"),
        ),
        "electricity_maps_api_key": ApiKeyResource(key=EnvVar("ELECTRICITY_MAPS_API_KEY")),
        "entsoe_api_key": ApiKeyResource(key=EnvVar("ENTSOE_API_KEY")),
    },
)
