"""Tests for the Electricity Maps history fetch and the co2_readings_daily asset."""

from datetime import UTC, date, datetime
from unittest.mock import MagicMock

import httpx
import pytest
import tenacity
from dagster import Failure, build_asset_context

from pipeline.assets import co2_intensity
from pipeline.assets.co2_intensity import (
    IntensityFetchConfig,
    IntensitySlot,
    _fetch_day_history,
    co2_readings_daily,
)

DAY = date(2026, 7, 14)


def _install_transport(monkeypatch: pytest.MonkeyPatch, handler) -> None:
    """Routes httpx.Client() traffic through a MockTransport."""
    real_client = httpx.Client
    monkeypatch.setattr(
        httpx, "Client", lambda **kw: real_client(transport=httpx.MockTransport(handler))
    )


def test_fetch_keeps_only_requested_day(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = {
        "history": [
            # previous day — must be dropped (endpoint returns a rolling 24 h)
            {"datetime": "2026-07-13T23:45:00Z", "carbonIntensity": 999},
            {
                "datetime": "2026-07-14T00:00:00Z",
                "carbonIntensity": 250,
                "renewablePercentage": 40.5,
            },
            {"datetime": "2026-07-14T00:15:00Z", "carbonIntensity": 240},
        ]
    }
    _install_transport(monkeypatch, lambda req: httpx.Response(200, json=payload))

    slots = _fetch_day_history("DE", DAY, "test-key")

    assert len(slots) == 2
    assert slots[0].timestamp == datetime(2026, 7, 14, tzinfo=UTC)
    assert slots[0].intensity_gco2_kwh == 250
    assert slots[0].renewable_percentage == 40.5
    assert slots[1].renewable_percentage is None
    assert all(s.source == "electricitymaps" for s in slots)


def test_fetch_http_error_includes_response_body(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_transport(
        monkeypatch, lambda req: httpx.Response(401, json={"message": "Invalid auth-token"})
    )
    # Skip tenacity's exponential backoff so the test doesn't sleep
    monkeypatch.setattr(_fetch_day_history.retry, "wait", tenacity.wait_none())

    with pytest.raises(RuntimeError, match="HTTP 401.*Invalid auth-token"):
        _fetch_day_history("DE", DAY, "bad-key")


def test_asset_upserts_fetched_slots(monkeypatch: pytest.MonkeyPatch) -> None:
    slot = IntensitySlot(
        region="DE",
        timestamp=datetime(2026, 7, 14, tzinfo=UTC),
        intensity_gco2_kwh=250.0,
        renewable_percentage=40.0,
    )
    monkeypatch.setattr(co2_intensity, "_fetch_day_history", lambda *a: [slot])
    supabase = MagicMock()
    ctx = build_asset_context(
        resources={"supabase": supabase, "electricity_maps_api_key": MagicMock(key="k")}
    )

    co2_readings_daily(ctx, IntensityFetchConfig(region="DE", fetch_date="2026-07-14"))

    supabase.upsert_co2_readings.assert_called_once_with(
        [
            {
                "region": "DE",
                "timestamp": "2026-07-14T00:00:00+00:00",
                "intensity_gco2_kwh": 250.0,
                "renewable_percentage": 40.0,
                "source": "electricitymaps",
            }
        ]
    )


def test_asset_skips_upsert_when_no_slots(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(co2_intensity, "_fetch_day_history", lambda *a: [])
    supabase = MagicMock()
    ctx = build_asset_context(
        resources={"supabase": supabase, "electricity_maps_api_key": MagicMock(key="k")}
    )

    co2_readings_daily(ctx, IntensityFetchConfig(region="DE", fetch_date="2026-07-14"))

    supabase.upsert_co2_readings.assert_not_called()


def test_asset_wraps_fetch_errors_in_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(*a: object) -> list[IntensitySlot]:
        raise RuntimeError("Electricity Maps request failed with HTTP 500: oops")

    monkeypatch.setattr(co2_intensity, "_fetch_day_history", _boom)
    supabase = MagicMock()
    ctx = build_asset_context(
        resources={"supabase": supabase, "electricity_maps_api_key": MagicMock(key="k")}
    )

    with pytest.raises(Failure, match="Electricity Maps fetch failed for DE / 2026-07-14"):
        co2_readings_daily(ctx, IntensityFetchConfig(region="DE", fetch_date="2026-07-14"))
    supabase.upsert_co2_readings.assert_not_called()
