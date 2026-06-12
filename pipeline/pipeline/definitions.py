from dagster import Definitions, EnvVar

from pipeline.assets.co2_intensity import co2_readings_daily
from pipeline.jobs.ingest_job import ingest_co2_job
from pipeline.resources.supabase_resource import SupabaseResource

defs = Definitions(
    assets=[co2_readings_daily],
    jobs=[ingest_co2_job],
    # No schedule — jobs are triggered manually (or via external orchestration)
    resources={
        "supabase": SupabaseResource(
            url=EnvVar("SUPABASE_URL"),
            service_role_key=EnvVar("SUPABASE_SERVICE_ROLE_KEY"),
        ),
        "electricity_maps_api_key": EnvVar("ELECTRICITY_MAPS_API_KEY"),
    },
)
