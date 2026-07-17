"""Asset-level tests for day_ahead_prices_entsoe (fetch mocked, parsing
covered by test_day_ahead_prices.py): chunked ranges, acknowledgement
handling, currency passthrough."""

from datetime import date, timedelta
from unittest.mock import MagicMock

import pytest
from dagster import Failure, build_asset_context

from pipeline.assets import day_ahead_prices_entsoe
from pipeline.assets.day_ahead_prices_entsoe import (
    DayAheadPriceFetchConfig,
)
from pipeline.assets.day_ahead_prices_entsoe import (
    day_ahead_prices_entsoe as day_ahead_prices_entsoe_asset,
)

ACK_NS = "urn:iec62325.351:tc57wg16:451-1:acknowledgementdocument:7:0"
ACK_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    f'<Acknowledgement_MarketDocument xmlns="{ACK_NS}">'
    "<Reason><code>999</code><text>No matching data found</text></Reason>"
    "</Acknowledgement_MarketDocument>"
)

PRICE_NS = "urn:iec62325.351:tc57wg16:451-3:publicationdocument:7:3"


def _price_doc(start: date, n_days: int = 1, currency: str = "EUR") -> str:
    """A flat 45/MWh document covering n_days at hourly resolution."""
    points = "".join(
        f"<Point><position>{i}</position><price.amount>45</price.amount></Point>"
        for i in range(1, n_days * 24 + 1)
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<Publication_MarketDocument xmlns="{PRICE_NS}"><TimeSeries>'
        "<in_Domain.mRID>10Y1001A1001A83F</in_Domain.mRID>"
        "<out_Domain.mRID>10Y1001A1001A83F</out_Domain.mRID>"
        f"<currency_Unit.name>{currency}</currency_Unit.name>"
        "<Period>"
        f"<timeInterval><start>{start}T00:00Z</start>"
        f"<end>{start + timedelta(days=n_days)}T00:00Z</end></timeInterval>"
        f"<resolution>PT60M</resolution>{points}"
        "</Period></TimeSeries></Publication_MarketDocument>"
    )


def _fake_fetch(eic: str, start: date, end_exclusive: date, key: str) -> str:
    return _price_doc(start, (end_exclusive - start).days)


def _supabase() -> MagicMock:
    return MagicMock()


def _context(supabase: MagicMock) -> object:
    return build_asset_context(
        resources={"supabase": supabase, "entsoe_api_key": MagicMock(key="token")}
    )


def test_asset_rejects_unknown_region() -> None:
    ctx = _context(_supabase())
    with pytest.raises(ValueError, match="Unknown region 'ZZ'"):
        day_ahead_prices_entsoe_asset(
            ctx, DayAheadPriceFetchConfig(region="ZZ", fetch_date="2026-07-14")
        )


def test_asset_rejects_inverted_date_range() -> None:
    with pytest.raises(ValueError, match="is before"):
        day_ahead_prices_entsoe_asset(
            _context(_supabase()),
            DayAheadPriceFetchConfig(
                region="DE", fetch_date="2026-07-16", fetch_end_date="2026-07-14"
            ),
        )


def test_asset_upserts_slots_with_currency(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(day_ahead_prices_entsoe, "_fetch_price_xml", _fake_fetch)
    supabase = _supabase()

    day_ahead_prices_entsoe_asset(
        _context(supabase), DayAheadPriceFetchConfig(region="DE", fetch_date="2026-07-14")
    )

    supabase.upsert_day_ahead_prices.assert_called_once()
    rows = supabase.upsert_day_ahead_prices.call_args.args[0]
    assert len(rows) == 96
    assert rows[0]["price"] == 45.0
    assert rows[0]["currency"] == "EUR"
    assert rows[0]["source"] == "entsoe"
    assert rows[0]["timestamp"] == "2026-07-14T00:00:00+00:00"


def test_non_eur_region_preserves_currency(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_fetch(eic: str, start: date, end_exclusive: date, key: str) -> str:
        return _price_doc(start, (end_exclusive - start).days, currency="SEK")

    monkeypatch.setattr(day_ahead_prices_entsoe, "_fetch_price_xml", fake_fetch)
    supabase = _supabase()

    day_ahead_prices_entsoe_asset(
        _context(supabase), DayAheadPriceFetchConfig(region="SE1", fetch_date="2026-07-14")
    )

    rows = supabase.upsert_day_ahead_prices.call_args.args[0]
    assert rows[0]["currency"] == "SEK"


def test_range_within_chunk_is_one_fetch(monkeypatch: pytest.MonkeyPatch) -> None:
    fetch_calls: list[tuple[date, date]] = []

    def counting_fetch(eic: str, start: date, end_exclusive: date, key: str) -> str:
        fetch_calls.append((start, end_exclusive))
        return _fake_fetch(eic, start, end_exclusive, key)

    monkeypatch.setattr(day_ahead_prices_entsoe, "_fetch_price_xml", counting_fetch)
    supabase = _supabase()

    day_ahead_prices_entsoe_asset(
        _context(supabase),
        DayAheadPriceFetchConfig(region="DE", fetch_date="2026-07-14", fetch_end_date="2026-07-16"),
    )

    assert fetch_calls == [(date(2026, 7, 14), date(2026, 7, 17))]
    rows = supabase.upsert_day_ahead_prices.call_args.args[0]
    assert len(rows) == 3 * 96


def test_long_range_splits_into_chunks(monkeypatch: pytest.MonkeyPatch) -> None:
    fetch_calls: list[tuple[date, date]] = []

    def counting_fetch(eic: str, start: date, end_exclusive: date, key: str) -> str:
        fetch_calls.append((start, end_exclusive))
        return _fake_fetch(eic, start, end_exclusive, key)

    monkeypatch.setattr(day_ahead_prices_entsoe, "_fetch_price_xml", counting_fetch)
    monkeypatch.setattr(day_ahead_prices_entsoe.time, "sleep", lambda s: None)
    supabase = _supabase()

    # 35 days -> one 31-day chunk + one 4-day chunk
    day_ahead_prices_entsoe_asset(
        _context(supabase),
        DayAheadPriceFetchConfig(region="DE", fetch_date="2026-06-01", fetch_end_date="2026-07-05"),
    )

    assert fetch_calls == [
        (date(2026, 6, 1), date(2026, 7, 2)),
        (date(2026, 7, 2), date(2026, 7, 6)),
    ]
    assert supabase.upsert_day_ahead_prices.call_count == 2
    total = sum(len(c.args[0]) for c in supabase.upsert_day_ahead_prices.call_args_list)
    assert total == 35 * 96


def test_chunks_without_data_are_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_fetch(eic: str, start: date, end_exclusive: date, key: str) -> str:
        if start == date(2026, 6, 1):
            return ACK_XML  # first chunk unpublished
        return _fake_fetch(eic, start, end_exclusive, key)

    monkeypatch.setattr(day_ahead_prices_entsoe, "_fetch_price_xml", fake_fetch)
    monkeypatch.setattr(day_ahead_prices_entsoe.time, "sleep", lambda s: None)
    supabase = _supabase()

    day_ahead_prices_entsoe_asset(
        _context(supabase),
        DayAheadPriceFetchConfig(region="DE", fetch_date="2026-06-01", fetch_end_date="2026-07-05"),
    )

    assert supabase.upsert_day_ahead_prices.call_count == 1
    assert len(supabase.upsert_day_ahead_prices.call_args.args[0]) == 4 * 96


def test_asset_fails_when_no_chunk_has_data(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(day_ahead_prices_entsoe, "_fetch_price_xml", lambda *a: ACK_XML)
    supabase = _supabase()

    with pytest.raises(Failure, match="No matching data found"):
        day_ahead_prices_entsoe_asset(
            _context(supabase), DayAheadPriceFetchConfig(region="DE", fetch_date="2026-07-14")
        )
    supabase.upsert_day_ahead_prices.assert_not_called()


def test_asset_wraps_fetch_errors_in_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(*a: object) -> str:
        raise RuntimeError("ENTSO-E request failed with HTTP 503: down")

    monkeypatch.setattr(day_ahead_prices_entsoe, "_fetch_price_xml", _boom)

    with pytest.raises(Failure, match="ENTSO-E fetch failed for DE / 2026-07-14"):
        day_ahead_prices_entsoe_asset(
            _context(_supabase()), DayAheadPriceFetchConfig(region="DE", fetch_date="2026-07-14")
        )
