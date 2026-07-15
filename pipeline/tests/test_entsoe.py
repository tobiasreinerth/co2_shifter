"""Tests for ENTSO-E A75 XML parsing and intensity derivation."""

from datetime import UTC, date, datetime

from pipeline.assets.co2_intensity_entsoe import (
    SLOTS_PER_DAY,
    compute_intensity_slots,
    parse_generation_xml,
)

NS = "urn:iec62325.351:tc57wg16:451-6:generationloaddocument:3:0"
DAY = date(2026, 7, 14)


def _doc(timeseries_xml: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<GL_MarketDocument xmlns="{NS}">{timeseries_xml}</GL_MarketDocument>'
    )


def _series(
    psr: str,
    points: list[tuple[int, float]],
    resolution: str = "PT15M",
    start: str = "2026-07-14T00:00Z",
    domain_tag: str = "inBiddingZone_Domain.mRID",
) -> str:
    pts = "".join(
        f"<Point><position>{pos}</position><quantity>{qty}</quantity></Point>"
        for pos, qty in points
    )
    return (
        "<TimeSeries>"
        f"<{domain_tag}>10Y1001A1001A83F</{domain_tag}>"
        f"<MktPSRType><psrType>{psr}</psrType></MktPSRType>"
        "<Period>"
        f"<timeInterval><start>{start}</start><end>2026-07-15T00:00Z</end></timeInterval>"
        f"<resolution>{resolution}</resolution>"
        f"{pts}"
        "</Period>"
        "</TimeSeries>"
    )


def test_parse_15min_series() -> None:
    xml = _doc(_series("B04", [(i, 1000.0) for i in range(1, 97)]))
    series = parse_generation_xml(xml, DAY)

    assert len(series) == 1
    assert series[0].psr_type == "B04"
    assert len(series[0].slot_mwh) == SLOTS_PER_DAY
    # 1000 MW for 15 min = 250 MWh per slot
    assert series[0].slot_mwh[0] == 250.0
    assert series[0].slot_mwh[95] == 250.0


def test_parse_hourly_series_expands_to_15min_slots() -> None:
    xml = _doc(_series("B19", [(i, 400.0) for i in range(1, 25)], resolution="PT60M"))
    series = parse_generation_xml(xml, DAY)

    assert len(series) == 1
    # 400 MW for each of 4 sub-slots = 100 MWh per 15-min slot
    assert all(mwh == 100.0 for mwh in series[0].slot_mwh)


def test_sparse_points_are_forward_filled() -> None:
    # Positions 2..95 omitted → repeat position 1's value; 96 present again
    xml = _doc(_series("B04", [(1, 1000.0), (96, 2000.0)]))
    series = parse_generation_xml(xml, DAY)

    assert series[0].slot_mwh[0] == 250.0
    assert series[0].slot_mwh[50] == 250.0  # forward-filled
    assert series[0].slot_mwh[95] == 500.0


def test_consumption_series_is_skipped() -> None:
    xml = _doc(
        _series("B10", [(1, 500.0)], domain_tag="outBiddingZone_Domain.mRID")
        + _series("B04", [(1, 1000.0)])
    )
    series = parse_generation_xml(xml, DAY)

    assert [s.psr_type for s in series] == ["B04"]


def test_intensity_is_generation_weighted_mean() -> None:
    # 3000 MW gas (490 g/kWh) + 1000 MW wind onshore (11 g/kWh), full day
    xml = _doc(
        _series("B04", [(i, 3000.0) for i in range(1, 97)])
        + _series("B19", [(i, 1000.0) for i in range(1, 97)])
    )
    slots = compute_intensity_slots("DE", DAY, parse_generation_xml(xml, DAY))

    assert len(slots) == SLOTS_PER_DAY
    expected = (3000 * 490 + 1000 * 11) / 4000  # 370.25
    assert slots[0].intensity_gco2_kwh == round(expected, 1)
    assert slots[0].renewable_percentage == 25.0
    assert slots[0].timestamp == datetime(2026, 7, 14, tzinfo=UTC)
    assert slots[0].source == "entsoe"


def test_slots_without_data_are_dropped() -> None:
    # Only the first hour has data (publication lag for the rest of the day)
    xml = _doc(_series("B04", [(i, 1000.0) for i in range(1, 5)]))
    slots = compute_intensity_slots("DE", DAY, parse_generation_xml(xml, DAY))

    assert len(slots) == 4
    assert slots[-1].timestamp == datetime(2026, 7, 14, 0, 45, tzinfo=UTC)
