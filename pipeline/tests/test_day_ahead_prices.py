"""Tests for ENTSO-E A44 XML parsing (day-ahead prices)."""

from datetime import UTC, datetime

from pipeline.assets.day_ahead_prices_entsoe import parse_price_xml

NS = "urn:iec62325.351:tc57wg16:451-3:publicationdocument:7:3"


def _doc(timeseries_xml: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<Publication_MarketDocument xmlns="{NS}">{timeseries_xml}</Publication_MarketDocument>'
    )


def _series(
    points: list[tuple[int, float]],
    resolution: str = "PT60M",
    start: str = "2026-07-14T00:00Z",
    end: str = "2026-07-15T00:00Z",
    currency: str = "EUR",
) -> str:
    pts = "".join(
        f"<Point><position>{pos}</position><price.amount>{price}</price.amount></Point>"
        for pos, price in points
    )
    return (
        "<TimeSeries>"
        "<in_Domain.mRID>10Y1001A1001A83F</in_Domain.mRID>"
        "<out_Domain.mRID>10Y1001A1001A83F</out_Domain.mRID>"
        f"<currency_Unit.name>{currency}</currency_Unit.name>"
        "<price_Measure_Unit.name>MWH</price_Measure_Unit.name>"
        "<Period>"
        f"<timeInterval><start>{start}</start><end>{end}</end></timeInterval>"
        f"<resolution>{resolution}</resolution>"
        f"{pts}"
        "</Period>"
        "</TimeSeries>"
    )


def _ts(hour: int, minute: int = 0, day: int = 14) -> datetime:
    return datetime(2026, 7, day, hour, minute, tzinfo=UTC)


def test_parse_hourly_series_expands_to_15min_slots() -> None:
    xml = _doc(_series([(i, 45.0) for i in range(1, 25)]))
    prices = parse_price_xml(xml)

    assert len(prices) == 96
    assert prices[_ts(0, 0)] == (45.0, "EUR")
    assert prices[_ts(0, 45)] == (45.0, "EUR")  # forward-filled within the hour
    assert prices[_ts(23, 45)] == (45.0, "EUR")


def test_parse_15min_series() -> None:
    xml = _doc(_series([(i, 30.0 + i) for i in range(1, 97)], resolution="PT15M"))
    prices = parse_price_xml(xml)

    assert len(prices) == 96
    assert prices[_ts(0, 0)] == (31.0, "EUR")
    assert prices[_ts(0, 15)] == (32.0, "EUR")


def test_sparse_points_are_forward_filled() -> None:
    # Positions 2..23 omitted → repeat position 1's value; 24 present again
    xml = _doc(_series([(1, 40.0), (24, 80.0)]))
    prices = parse_price_xml(xml)

    assert prices[_ts(0, 0)] == (40.0, "EUR")
    assert prices[_ts(12, 0)] == (40.0, "EUR")  # forward-filled
    assert prices[_ts(23, 0)] == (80.0, "EUR")


def test_non_eur_currency_is_preserved() -> None:
    xml = _doc(_series([(i, 450.0) for i in range(1, 25)], currency="SEK"))
    prices = parse_price_xml(xml)

    assert prices[_ts(0, 0)] == (450.0, "SEK")


def test_multi_day_document() -> None:
    xml = _doc(
        _series(
            [(i, 50.0) for i in range(1, 49)],
            end="2026-07-16T00:00Z",
        )
    )
    prices = parse_price_xml(xml)

    assert len(prices) == 192  # 2 days x 96 slots
    assert prices[_ts(0, 0, day=14)] == (50.0, "EUR")
    assert prices[_ts(23, 45, day=15)] == (50.0, "EUR")


def test_no_timeseries_returns_empty() -> None:
    assert parse_price_xml(_doc("")) == {}
