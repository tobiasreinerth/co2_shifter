"""Tests for SupabaseResource: upsert error handling and emission-factor loading."""

from types import SimpleNamespace

import pytest
from dagster import Failure
from postgrest.exceptions import APIError
from supabase import Client

from pipeline.resources.supabase_resource import SupabaseResource


class _RecordingTable:
    """Stands in for a postgrest table builder; records upsert/select calls."""

    def __init__(
        self,
        error: Exception | None = None,
        select_data: list[dict[str, object]] | None = None,
    ) -> None:
        self.error = error
        self.select_data = select_data or []
        self.rows: list[dict[str, object]] | None = None
        self.on_conflict: str | None = None

    def upsert(self, rows: list[dict[str, object]], on_conflict: str) -> "_RecordingTable":
        self.rows = rows
        self.on_conflict = on_conflict
        return self

    def select(self, columns: str) -> "_RecordingTable":
        return self

    def execute(self) -> SimpleNamespace:
        if self.error:
            raise self.error
        return SimpleNamespace(data=self.select_data)


class _StubSupabaseResource(SupabaseResource):
    """SupabaseResource whose client is replaced by recording stubs."""

    def get_client(self) -> Client:
        return self._stub_client  # type: ignore[attr-defined,no-any-return]


def _make_resource(tables: dict[str, _RecordingTable]) -> _StubSupabaseResource:
    resource = _StubSupabaseResource(url="http://localhost", service_role_key="key")

    class _StubClient:
        def table(self, name: str) -> _RecordingTable:
            return tables[name]

    object.__setattr__(resource, "_stub_client", _StubClient())
    return resource


def _factor_row(psr: str, name: str, factor: float, renewable: bool) -> dict[str, object]:
    return {
        "psr_type": psr,
        "source_name": name,
        "factor_gco2eq_per_kwh": factor,
        "is_renewable": renewable,
        "citation": "test",
        "updated_at": "2026-07-16T00:00:00+00:00",
    }


def test_upsert_targets_region_timestamp_conflict() -> None:
    table = _RecordingTable()
    rows = [{"region": "DE", "timestamp": "2026-07-14T00:00:00+00:00"}]

    _make_resource({"co2_readings": table}).upsert_co2_readings(rows)

    assert table.rows == rows
    assert table.on_conflict == "region,timestamp"


def test_upsert_wraps_postgrest_errors_in_failure() -> None:
    table = _RecordingTable(
        error=APIError({"message": "permission denied for table co2_readings"})
    )

    with pytest.raises(Failure, match="permission denied for table co2_readings"):
        _make_resource({"co2_readings": table}).upsert_co2_readings([{"region": "DE"}])


def test_fetch_emission_factors_returns_keyed_models() -> None:
    table = _RecordingTable(
        select_data=[
            _factor_row("B04", "fossil_gas", 490.0, False),
            _factor_row("B20", "other", 700.0, False),
        ]
    )

    factors = _make_resource({"emission_factors": table}).fetch_emission_factors()

    assert set(factors) == {"B04", "B20"}
    assert factors["B04"].factor_gco2eq_per_kwh == 490.0
    assert factors["B04"].is_renewable is False


def test_fetch_emission_factors_fails_on_empty_table() -> None:
    table = _RecordingTable(select_data=[])

    with pytest.raises(Failure, match="emission_factors table is empty"):
        _make_resource({"emission_factors": table}).fetch_emission_factors()


def test_fetch_emission_factors_requires_b20_fallback() -> None:
    table = _RecordingTable(select_data=[_factor_row("B04", "fossil_gas", 490.0, False)])

    with pytest.raises(Failure, match="missing the 'B20'"):
        _make_resource({"emission_factors": table}).fetch_emission_factors()
