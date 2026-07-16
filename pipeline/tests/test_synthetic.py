"""Tests for the synthetic seed curve and the co2_readings_synthetic asset."""

from datetime import UTC, date, datetime, timedelta
from unittest.mock import MagicMock

from dagster import build_asset_context

from pipeline.assets.co2_intensity_synthetic import (
    SLOTS_PER_DAY,
    SyntheticSeedConfig,
    _generate_day,
    _slot_intensity,
    co2_readings_synthetic,
)

DAY = date(2026, 7, 14)


def test_slot_intensity_stays_in_plausible_bounds() -> None:
    for slot in range(SLOTS_PER_DAY):
        intensity, renewable = _slot_intensity(slot)
        assert intensity > 0
        assert 5.0 <= renewable <= 95.0


def test_curve_has_solar_dip_and_evening_peak() -> None:
    midday, _ = _slot_intensity(13 * 4)  # 13:00 — solar dip center
    evening, _ = _slot_intensity(19 * 4)  # 19:00 — gas-peaker peak
    midnight, _ = _slot_intensity(0)

    assert midday < midnight < evening


def test_generate_day_covers_full_day_in_utc() -> None:
    slots = _generate_day("DE", DAY)

    assert len(slots) == SLOTS_PER_DAY
    assert slots[0].timestamp == datetime(2026, 7, 14, tzinfo=UTC)
    assert slots[-1].timestamp == datetime(2026, 7, 14, 23, 45, tzinfo=UTC)
    assert all(
        b.timestamp - a.timestamp == timedelta(minutes=15)
        for a, b in zip(slots, slots[1:])
    )
    assert all(s.region == "DE" and s.source == "synthetic_seed" for s in slots)


def test_asset_upserts_96_rows() -> None:
    supabase = MagicMock()
    ctx = build_asset_context(resources={"supabase": supabase})

    co2_readings_synthetic(ctx, SyntheticSeedConfig(region="FR", fetch_date="2026-07-14"))

    supabase.upsert_co2_readings.assert_called_once()
    rows = supabase.upsert_co2_readings.call_args.args[0]
    assert len(rows) == SLOTS_PER_DAY
    assert rows[0] == {
        "region": "FR",
        "timestamp": "2026-07-14T00:00:00+00:00",
        "intensity_gco2_kwh": rows[0]["intensity_gco2_kwh"],
        "renewable_percentage": rows[0]["renewable_percentage"],
        "source": "synthetic_seed",
    }
