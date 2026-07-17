"""Dagster resource wrapping the Supabase Python client."""

import httpx
from dagster import ConfigurableResource, Failure
from postgrest.exceptions import APIError
from pydantic import BaseModel
from supabase import Client, create_client


class EmissionFactor(BaseModel):
    """One emission_factors row — the source of truth for intensity math."""

    psr_type: str
    source_name: str
    factor_gco2eq_per_kwh: float
    is_renewable: bool


class SupabaseResource(ConfigurableResource):
    """Provides an authenticated Supabase client (service-role key, full access)."""

    url: str
    service_role_key: str

    def get_client(self) -> Client:
        """Creates a fresh Supabase client for this resource's project."""
        return create_client(self.url, self.service_role_key)

    def fetch_emission_factors(self) -> dict[str, EmissionFactor]:
        """Loads the emission_factors table, keyed by PSR type (e.g. "B04").

        The table is authoritative — edits there apply to the next ingest run.
        Fails loudly when the table is empty, a factor is non-positive, or the
        "B20" fallback row (used for unmapped production types) is missing.
        """
        try:
            resp = self.get_client().table("emission_factors").select("*").execute()
        except (APIError, httpx.HTTPError) as exc:
            raise Failure(description=f"Could not load emission_factors: {exc}") from exc

        factors = {row["psr_type"]: EmissionFactor(**row) for row in resp.data or []}

        if not factors:
            raise Failure(
                description="emission_factors table is empty — run migration 003 to seed it."
            )
        if "B20" not in factors:
            raise Failure(
                description="emission_factors is missing the 'B20' (other) fallback row."
            )
        bad = [f.psr_type for f in factors.values() if f.factor_gco2eq_per_kwh <= 0]
        if bad:
            raise Failure(
                description=f"emission_factors has non-positive factors for: {bad}"
            )
        return factors

    def upsert_co2_readings(self, rows: list[dict[str, object]]) -> None:
        """Upserts intensity rows into co2_readings on (region, timestamp).

        Raises dagster.Failure with the Supabase error detail so ingestion runs
        fail loudly instead of silently dropping data.
        """
        try:
            self.get_client().table("co2_readings").upsert(
                rows, on_conflict="region,timestamp"
            ).execute()
        except APIError as exc:
            raise Failure(
                description=f"Supabase upsert into co2_readings failed: {exc.message}"
            ) from exc
        except httpx.HTTPError as exc:
            raise Failure(
                description=f"Could not reach Supabase at {self.url}: {exc}"
            ) from exc

    def upsert_day_ahead_prices(self, rows: list[dict[str, object]]) -> None:
        """Upserts price rows into day_ahead_prices on (region, timestamp).

        Raises dagster.Failure with the Supabase error detail so ingestion runs
        fail loudly instead of silently dropping data.
        """
        try:
            self.get_client().table("day_ahead_prices").upsert(
                rows, on_conflict="region,timestamp"
            ).execute()
        except APIError as exc:
            raise Failure(
                description=f"Supabase upsert into day_ahead_prices failed: {exc.message}"
            ) from exc
        except httpx.HTTPError as exc:
            raise Failure(
                description=f"Could not reach Supabase at {self.url}: {exc}"
            ) from exc
