"""Shared test fixtures for the pipeline test suite."""

from pipeline.resources.supabase_resource import EmissionFactor


def make_factors() -> dict[str, EmissionFactor]:
    """A small emission-factor set mirroring migration-seeded values."""
    rows = [
        ("B04", "fossil_gas", 490.0, False),
        ("B10", "hydro_pumped_storage", 24.0, True),
        ("B16", "solar", 45.0, True),
        ("B19", "wind_onshore", 11.0, True),
        ("B20", "other", 700.0, False),
    ]
    return {
        psr: EmissionFactor(
            psr_type=psr, source_name=name, factor_gco2eq_per_kwh=factor, is_renewable=renewable
        )
        for psr, name, factor, renewable in rows
    }
