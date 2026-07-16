"""Fetches a full day of 15-min CO2 intensity history from Electricity Maps.

One Dagster run = one (region, date) pair → 96 rows upserted into co2_readings.
Triggered manually or via the daily backfill job.
"""

from datetime import UTC, date, datetime, timedelta

import httpx
from dagster import AssetExecutionContext, Config, Failure, asset
from pydantic import BaseModel
from tenacity import retry, stop_after_attempt, wait_exponential

from pipeline.resources.supabase_resource import SupabaseResource

SLOTS_PER_DAY = 96  # 24h × 4


class IntensityFetchConfig(Config):
    """Run config: which region/day to ingest. Empty fetch_date means yesterday."""

    region: str = "DE"
    fetch_date: str = ""  # ISO date string, e.g. "2024-06-01"; defaults to yesterday


class IntensitySlot(BaseModel):
    """One 15-min co2_readings row from the Electricity Maps history endpoint."""

    region: str
    timestamp: datetime
    intensity_gco2_kwh: float
    renewable_percentage: float | None = None
    source: str = "electricitymaps"


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=10),
    reraise=True,
)
def _fetch_day_history(region: str, day: date, api_key: str) -> list[IntensitySlot]:
    """Fetches ~96 15-min intensity slots for a given day via Electricity Maps history endpoint.

    Retries transient failures 3× with backoff; HTTP errors include the response
    body snippet (Electricity Maps returns the reason as JSON, e.g. bad token).
    """
    # The history endpoint returns the last 24 h relative to a given datetime
    day_end = datetime(day.year, day.month, day.day, 23, 59, tzinfo=UTC)
    url = (
        f"https://api.electricitymaps.com/v3/carbon-intensity/history"
        f"?zone={region}&datetime={day_end.strftime('%Y-%m-%dT%H:%M:%SZ')}"
    )
    with httpx.Client(timeout=20) as client:
        resp = client.get(url, headers={"auth-token": api_key})
        try:
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(
                f"Electricity Maps request failed with HTTP {resp.status_code}: "
                f"{resp.text[:300]}"
            ) from exc
        data = resp.json()

    slots = []
    for entry in data.get("history", []):
        ts = datetime.fromisoformat(entry["datetime"].replace("Z", "+00:00"))
        # Only keep slots belonging to the requested day
        if ts.date() != day:
            continue
        slots.append(
            IntensitySlot(
                region=region,
                timestamp=ts,
                intensity_gco2_kwh=entry["carbonIntensity"],
                renewable_percentage=entry.get("renewablePercentage"),
            )
        )
    return slots


@asset(
    group_name="ingestion",
    description=(
        "Fetches a full day of 15-min CO2 intensity history for a region. "
        "Run once per (region, date) to populate co2_readings."
    ),
    required_resource_keys={"supabase", "electricity_maps_api_key"},
)
def co2_readings_daily(context: AssetExecutionContext, config: IntensityFetchConfig) -> None:
    """Ingests one (region, date) of Electricity Maps CO2 intensity into co2_readings."""
    api_key: str = context.resources.electricity_maps_api_key.key
    supabase: SupabaseResource = context.resources.supabase

    target_date = (
        date.fromisoformat(config.fetch_date)
        if config.fetch_date
        else date.today() - timedelta(days=1)
    )

    context.log.info(f"Fetching {config.region} for {target_date}")
    try:
        slots = _fetch_day_history(config.region, target_date, api_key)
    except (httpx.HTTPError, RuntimeError, KeyError, ValueError) as exc:
        raise Failure(
            description=(
                f"Electricity Maps fetch failed for {config.region} / {target_date}: {exc}"
            )
        ) from exc

    if not slots:
        context.log.warning("No slots returned — check region and date.")
        return

    rows = [
        {
            "region": s.region,
            "timestamp": s.timestamp.isoformat(),
            "intensity_gco2_kwh": s.intensity_gco2_kwh,
            "renewable_percentage": s.renewable_percentage,
            "source": s.source,
        }
        for s in slots
    ]

    supabase.upsert_co2_readings(rows)
    context.log.info(f"Upserted {len(rows)} slots for {config.region} / {target_date}")
