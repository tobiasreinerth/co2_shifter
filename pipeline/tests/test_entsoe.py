"""Tests for ENTSO-E A75 XML parsing and intensity derivation."""

from datetime import UTC, date, datetime

from pipeline.assets.co2_intensity_entsoe import (
    compute_intensity_slots,
    parse_generation_xml,
)
from tests.conftest import make_factors

NS = "urn:iec62325.351:tc57wg16:451-6:generationloaddocument:3:0"
DAY = date(2026, 7, 14)
DAY_START = datetime(2026, 7, 14, tzinfo=UTC)


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
    end: str = "2026-07-15T00:00Z",
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
        f"<timeInterval><start>{start}</start><end>{end}</end></timeInterval>"
        f"<resolution>{resolution}</resolution>"
        f"{pts}"
        "</Period>"
        "</TimeSeries>"
    )


def _ts(hour: int, minute: int = 0, day: int = 14) -> datetime:
    return datetime(2026, 7, day, hour, minute, tzinfo=UTC)


def test_parse_15min_series() -> None:
    xml = _doc(_series("B04", [(i, 1000.0) for i in range(1, 97)]))
    generation = parse_generation_xml(xml)

    assert set(generation) == {"B04"}
    slots = generation["B04"]
    assert len(slots) == 96
    # 1000 MW for 15 min = 250 MWh per slot
    assert slots[_ts(0, 0)] == 250.0
    assert slots[_ts(23, 45)] == 250.0


def test_parse_hourly_series_expands_to_15min_slots() -> None:
    xml = _doc(_series("B19", [(i, 400.0) for i in range(1, 25)], resolution="PT60M"))
    generation = parse_generation_xml(xml)

    # 400 MW for each of 4 sub-slots = 100 MWh per 15-min slot
    assert len(generation["B19"]) == 96
    assert all(mwh == 100.0 for mwh in generation["B19"].values())


def test_parse_multi_day_document() -> None:
    # One hourly Period spanning two full days — chunked fetching returns these
    xml = _doc(
        _series(
            "B04",
            [(i, 400.0) for i in range(1, 49)],
            resolution="PT60M",
            end="2026-07-16T00:00Z",
        )
    )
    generation = parse_generation_xml(xml)

    assert len(generation["B04"]) == 192  # 2 days × 96 slots
    assert generation["B04"][_ts(0, 0, day=14)] == 100.0
    assert generation["B04"][_ts(23, 45, day=15)] == 100.0


def test_sparse_points_are_forward_filled() -> None:
    # Positions 2..95 omitted → repeat position 1's value; 96 present again
    xml = _doc(_series("B04", [(1, 1000.0), (96, 2000.0)]))
    slots = parse_generation_xml(xml)["B04"]

    assert slots[_ts(0, 0)] == 250.0
    assert slots[_ts(12, 30)] == 250.0  # forward-filled
    assert slots[_ts(23, 45)] == 500.0


def test_consumption_series_is_skipped() -> None:
    xml = _doc(
        _series("B10", [(1, 500.0)], domain_tag="outBiddingZone_Domain.mRID")
        + _series("B04", [(1, 1000.0)])
    )
    generation = parse_generation_xml(xml)

    assert set(generation) == {"B04"}


def test_intensity_is_generation_weighted_mean_with_mix() -> None:
    # 3000 MW gas (490 g/kWh) + 1000 MW wind onshore (11 g/kWh), full day
    xml = _doc(
        _series("B04", [(i, 3000.0) for i in range(1, 97)])
        + _series("B19", [(i, 1000.0) for i in range(1, 97)])
    )
    slots = compute_intensity_slots("DE", parse_generation_xml(xml), make_factors())

    assert len(slots) == 96
    expected = (3000 * 490 + 1000 * 11) / 4000  # 370.25
    assert slots[0].intensity_gco2_kwh == round(expected, 1)
    assert slots[0].renewable_percentage == 25.0
    assert slots[0].generation_mix == {"fossil_gas": 75.0, "wind_onshore": 25.0}
    assert slots[0].timestamp == DAY_START
    assert slots[0].source == "entsoe"


def test_unknown_psr_type_falls_back_to_other() -> None:
    xml = _doc(_series("B99", [(i, 1000.0) for i in range(1, 97)]))
    slots = compute_intensity_slots("DE", parse_generation_xml(xml), make_factors())

    assert slots[0].intensity_gco2_kwh == 700.0  # the B20 "other" factor
    assert slots[0].renewable_percentage == 0.0
    assert slots[0].generation_mix == {"other": 100.0}


def test_slots_without_data_are_dropped() -> None:
    # Only the first hour has data (publication lag for the rest of the day)
    xml = _doc(_series("B04", [(i, 1000.0) for i in range(1, 5)]))
    slots = compute_intensity_slots("DE", parse_generation_xml(xml), make_factors())

    assert len(slots) == 4
    assert slots[-1].timestamp == _ts(0, 45)
