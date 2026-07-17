from dagster import define_asset_job

from pipeline.assets.day_ahead_prices_entsoe import day_ahead_prices_entsoe

ingest_day_ahead_prices_job = define_asset_job(
    name="ingest_day_ahead_prices_job",
    selection=[day_ahead_prices_entsoe],
    description=(
        "Fetches day-ahead electricity auction prices from ENTSO-E. Pass "
        "config: {region, fetch_date} or trigger without config for yesterday."
    ),
)
