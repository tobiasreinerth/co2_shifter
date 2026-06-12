from dagster import define_asset_job

from pipeline.assets.co2_intensity import co2_readings_daily

ingest_co2_job = define_asset_job(
    name="ingest_co2_job",
    selection=[co2_readings_daily],
    description=(
        "Fetches one day of 15-min CO2 intensity history for a region. "
        "Pass config: {region, fetch_date} or trigger without config for yesterday."
    ),
)
