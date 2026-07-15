"""Seeds a hardcoded, stylized 96-slot CO2 intensity curve — a stand-in for
real grid data while ENTSO-E API access is pending.

Shape: midday dip (solar-heavy generation), evening peak (~18:00-20:00, gas
peakers), moderate overnight baseload. Not measured data — replace with a
real ENTSO-E-backed asset once that integration lands.
"""

import math
from datetime import UTC, date, datetime, timedelta

from dagster import AssetExecutionContext, Config, asset
from pydantic import BaseModel

from pipeline.resources.supabase_resource import SupabaseResource

SLOTS_PER_DAY = 96  # 24h x 4
BASELINE_GCO2_KWH = 300.0
SOLAR_DIP_GCO2_KWH = 130.0
EVENING_PEAK_GCO2_KWH = 150.0


class SyntheticSeedConfig(Config):
    region: str = "DE"
    fetch_date: str = ""  # ISO date string; defaults to today


class SyntheticSlot(BaseModel):
    region: str
    timestamp: datetime
    intensity_gco2_kwh: float
    renewable_percentage: float
    source: str = "synthetic_seed"


def _slot_intensity(slot: int) -> tuple[float, float]:
    """Returns (intensity_gco2_kwh, renewable_percentage) for a given 15-min slot."""
    hour = slot / 4

    # Solar dip centered at 13:00, widest mid-day
    solar_factor = max(0.0, math.cos((hour - 13) / 7 * (math.pi / 2)))
    intensity = BASELINE_GCO2_KWH - SOLAR_DIP_GCO2_KWH * solar_factor

    # Evening peak centered at 19:00 (gas peakers covering the post-solar ramp)
    evening_factor = math.exp(-((hour - 19) ** 2) / (2 * 1.5**2))
    intensity += EVENING_PEAK_GCO2_KWH * evening_factor

    renewable_pct = max(5.0, min(95.0, 20.0 + 70.0 * solar_factor - 30.0 * evening_factor))

    return round(intensity, 1), round(renewable_pct, 1)


def _generate_day(region: str, day: date) -> list[SyntheticSlot]:
    slots = []
    for i in range(SLOTS_PER_DAY):
        ts = datetime(day.year, day.month, day.day, tzinfo=UTC) + timedelta(minutes=15 * i)
        intensity, renewable_pct = _slot_intensity(i)
        slots.append(
            SyntheticSlot(
                region=region,
                timestamp=ts,
                intensity_gco2_kwh=intensity,
                renewable_percentage=renewable_pct,
            )
        )
    return slots


@asset(
    group_name="ingestion",
    description=(
        "Seeds a hardcoded, stylized 96-slot CO2 intensity curve for a region/date. "
        "Placeholder for real grid data — no external API call. Replace with the "
        "ENTSO-E-backed asset once that integration is ready."
    ),
    required_resource_keys={"supabase"},
)
def co2_readings_synthetic(context: AssetExecutionContext, config: SyntheticSeedConfig) -> None:
    supabase: SupabaseResource = context.resources.supabase

    target_date = (
        date.fromisoformat(config.fetch_date) if config.fetch_date else date.today()
    )

    context.log.info(f"Seeding synthetic CO2 data for {config.region} / {target_date}")
    slots = _generate_day(config.region, target_date)

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

    supabase.get_client().table("co2_readings").upsert(
        rows, on_conflict="region,timestamp"
    ).execute()
    context.log.info(f"Upserted {len(rows)} synthetic slots for {config.region} / {target_date}")
