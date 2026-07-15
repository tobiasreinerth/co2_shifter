from dagster import define_asset_job

from pipeline.assets.co2_intensity_entsoe import co2_readings_entsoe

ingest_entsoe_job = define_asset_job(
    name="ingest_entsoe_job",
    selection=[co2_readings_entsoe],
    description=(
        "Fetches real generation-mix data from ENTSO-E and derives 15-min CO2 "
        "intensity. Pass config: {region, fetch_date} or trigger without config "
        "for yesterday."
    ),
)
