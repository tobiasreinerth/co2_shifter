"""Asset-level tests for co2_readings_entsoe (fetch mocked, parsing covered
by test_entsoe.py): chunked ranges, acknowledgement handling, mix rows."""

from datetime import date, timedelta
from unittest.mock import MagicMock

import pytest
from dagster import Failure, build_asset_context

from pipeline.assets import co2_intensity_entsoe
from pipeline.assets.co2_intensity_entsoe import (
    EntsoeFetchConfig,
    co2_readings_entsoe,
    raise_if_acknowledgement,
)
from tests.conftest import make_factors

ACK_NS = "urn:iec62325.351:tc57wg16:451-1:acknowledgementdocument:7:0"
ACK_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    f'<Acknowledgement_MarketDocument xmlns="{ACK_NS}">'
    "<Reason><code>999</code><text>No matching data found</text></Reason>"
    "</Acknowledgement_MarketDocument>"
)

GEN_NS = "urn:iec62325.351:tc57wg16:451-6:generationloaddocument:3:0"


def _generation_doc(start: date, n_days: int = 1) -> str:
    """A pure-gas (B04) document covering n_days at 15-min resolution."""
    points = "".join(
        f"<Point><position>{i}</position><quantity>1000</quantity></Point>"
        for i in range(1, n_days * 96 + 1)
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<GL_MarketDocument xmlns="{GEN_NS}"><TimeSeries>'
        "<inBiddingZone_Domain.mRID>10Y1001A1001A83F</inBiddingZone_Domain.mRID>"
        "<MktPSRType><psrType>B04</psrType></MktPSRType>"
        "<Period>"
        f"<timeInterval><start>{start}T00:00Z</start>"
        f"<end>{start + timedelta(days=n_days)}T00:00Z</end></timeInterval>"
        f"<resolution>PT15M</resolution>{points}"
        "</Period></TimeSeries></GL_MarketDocument>"
    )


def _fake_fetch(eic: str, start: date, end_exclusive: date, key: str) -> str:
    return _generation_doc(start, (end_exclusive - start).days)


def _supabase() -> MagicMock:
    supabase = MagicMock()
    supabase.fetch_emission_factors.return_value = make_factors()
    return supabase


def _context(supabase: MagicMock) -> object:
    return build_asset_context(
        resources={"supabase": supabase, "entsoe_api_key": MagicMock(key="token")}
    )


def test_raise_if_acknowledgement_surfaces_reason() -> None:
    with pytest.raises(ValueError, match="No matching data found"):
        raise_if_acknowledgement(ACK_XML)


def test_raise_if_acknowledgement_passes_generation_doc() -> None:
    raise_if_acknowledgement(_generation_doc(date(2026, 7, 14)))  # must not raise


def test_raise_if_acknowledgement_rejects_garbage() -> None:
    with pytest.raises(ValueError, match="unparseable XML"):
        raise_if_acknowledgement("<html>gateway timeout")


def test_asset_rejects_unknown_region() -> None:
    ctx = _context(_supabase())
    with pytest.raises(ValueError, match="Unknown region 'ZZ'"):
        co2_readings_entsoe(ctx, EntsoeFetchConfig(region="ZZ", fetch_date="2026-07-14"))


def test_asset_rejects_inverted_date_range() -> None:
    with pytest.raises(ValueError, match="is before"):
        co2_readings_entsoe(
            _context(_supabase()),
            EntsoeFetchConfig(region="DE", fetch_date="2026-07-16", fetch_end_date="2026-07-14"),
        )


def test_asset_upserts_slots_with_mix(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(co2_intensity_entsoe, "_fetch_generation_xml", _fake_fetch)
    supabase = _supabase()

    co2_readings_entsoe(
        _context(supabase), EntsoeFetchConfig(region="DE", fetch_date="2026-07-14")
    )

    supabase.fetch_emission_factors.assert_called_once()
    supabase.upsert_co2_readings.assert_called_once()
    rows = supabase.upsert_co2_readings.call_args.args[0]
    assert len(rows) == 96
    # Pure gas (B04) → intensity equals the gas emission factor, 100% gas mix
    assert rows[0]["intensity_gco2_kwh"] == 490.0
    assert rows[0]["renewable_percentage"] == 0.0
    assert rows[0]["generation_mix"] == {"fossil_gas": 100.0}
    assert rows[0]["source"] == "entsoe"
    assert rows[0]["timestamp"] == "2026-07-14T00:00:00+00:00"


def test_range_within_chunk_is_one_fetch(monkeypatch: pytest.MonkeyPatch) -> None:
    fetch_calls: list[tuple[date, date]] = []

    def counting_fetch(eic: str, start: date, end_exclusive: date, key: str) -> str:
        fetch_calls.append((start, end_exclusive))
        return _fake_fetch(eic, start, end_exclusive, key)

    monkeypatch.setattr(co2_intensity_entsoe, "_fetch_generation_xml", counting_fetch)
    supabase = _supabase()

    co2_readings_entsoe(
        _context(supabase),
        EntsoeFetchConfig(region="DE", fetch_date="2026-07-14", fetch_end_date="2026-07-16"),
    )

    # 3 days fit one chunk: a single sweep request, a single bulk upsert
    assert fetch_calls == [(date(2026, 7, 14), date(2026, 7, 17))]
    rows = supabase.upsert_co2_readings.call_args.args[0]
    assert len(rows) == 3 * 96
    assert rows[0]["timestamp"] == "2026-07-14T00:00:00+00:00"
    assert rows[-1]["timestamp"] == "2026-07-16T23:45:00+00:00"


def test_long_range_splits_into_chunks(monkeypatch: pytest.MonkeyPatch) -> None:
    fetch_calls: list[tuple[date, date]] = []

    def counting_fetch(eic: str, start: date, end_exclusive: date, key: str) -> str:
        fetch_calls.append((start, end_exclusive))
        return _fake_fetch(eic, start, end_exclusive, key)

    monkeypatch.setattr(co2_intensity_entsoe, "_fetch_generation_xml", counting_fetch)
    monkeypatch.setattr(co2_intensity_entsoe.time, "sleep", lambda s: None)
    supabase = _supabase()

    # 35 days → one 31-day chunk + one 4-day chunk
    co2_readings_entsoe(
        _context(supabase),
        EntsoeFetchConfig(region="DE", fetch_date="2026-06-01", fetch_end_date="2026-07-05"),
    )

    assert fetch_calls == [
        (date(2026, 6, 1), date(2026, 7, 2)),
        (date(2026, 7, 2), date(2026, 7, 6)),
    ]
    assert supabase.upsert_co2_readings.call_count == 2
    total = sum(len(c.args[0]) for c in supabase.upsert_co2_readings.call_args_list)
    assert total == 35 * 96


def test_chunks_without_data_are_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_fetch(eic: str, start: date, end_exclusive: date, key: str) -> str:
        if start == date(2026, 6, 1):
            return ACK_XML  # first chunk unpublished
        return _fake_fetch(eic, start, end_exclusive, key)

    monkeypatch.setattr(co2_intensity_entsoe, "_fetch_generation_xml", fake_fetch)
    monkeypatch.setattr(co2_intensity_entsoe.time, "sleep", lambda s: None)
    supabase = _supabase()

    co2_readings_entsoe(
        _context(supabase),
        EntsoeFetchConfig(region="DE", fetch_date="2026-06-01", fetch_end_date="2026-07-05"),
    )

    # First chunk skipped, second chunk (4 days) still lands
    assert supabase.upsert_co2_readings.call_count == 1
    assert len(supabase.upsert_co2_readings.call_args.args[0]) == 4 * 96


def test_asset_fails_when_no_chunk_has_data(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(co2_intensity_entsoe, "_fetch_generation_xml", lambda *a: ACK_XML)
    supabase = _supabase()

    with pytest.raises(Failure, match="No matching data found"):
        co2_readings_entsoe(
            _context(supabase), EntsoeFetchConfig(region="DE", fetch_date="2026-07-14")
        )
    supabase.upsert_co2_readings.assert_not_called()


def test_asset_wraps_fetch_errors_in_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(*a: object) -> str:
        raise RuntimeError("ENTSO-E request failed with HTTP 503: down")

    monkeypatch.setattr(co2_intensity_entsoe, "_fetch_generation_xml", _boom)

    with pytest.raises(Failure, match="ENTSO-E fetch failed for DE / 2026-07-14"):
        co2_readings_entsoe(
            _context(_supabase()), EntsoeFetchConfig(region="DE", fetch_date="2026-07-14")
        )
