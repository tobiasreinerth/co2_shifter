from dagster import define_asset_job

from pipeline.assets.co2_intensity_synthetic import co2_readings_synthetic

seed_co2_job = define_asset_job(
    name="seed_co2_job",
    selection=[co2_readings_synthetic],
    description=(
        "Seeds a hardcoded, stylized CO2 intensity curve for one day (no external "
        "API call). Pass config: {region, fetch_date} or trigger without config "
        "for today."
    ),
)
