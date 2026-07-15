"""Fetches actual generation per production type from the ENTSO-E Transparency
Platform and derives 15-min CO2 intensity for a region/date.

Approach: production-based intensity. For each 15-min slot, the grid intensity
is the generation-weighted mean of per-technology lifecycle emission factors:

    intensity[slot] = Σ(gen_type_mwh × factor_g_per_kwh) / Σ(gen_type_mwh)

This ignores imports/exports (consumption-based accounting would require
cross-border flow tracing). Renewable % is the renewable share of generation.

API: GET /api?documentType=A75&processType=A16 (actual generation per type),
XML GL_MarketDocument. Quantities are MW averaged over the period resolution.
"""

from datetime import UTC, date, datetime, timedelta
from xml.etree import ElementTree

import httpx
from dagster import AssetExecutionContext, Config, asset
from pydantic import BaseModel
from tenacity import retry, stop_after_attempt, wait_exponential

from pipeline.resources.supabase_resource import SupabaseResource

SLOTS_PER_DAY = 96  # 24h × 4
ENTSOE_API_URL = "https://web-api.tp.entsoe.eu/api"

# Bidding-zone EIC codes for the regions the frontend offers
REGION_TO_EIC = {
    "DE": "10Y1001A1001A83F",  # DE-LU bidding zone
    "FR": "10YFR-RTE------C",
    # No GB: stopped publishing to ENTSO-E 2021-06-15 (post-Brexit TCA);
    # use Elexon BMRS or carbonintensity.org.uk if GB support is needed
    "ES": "10YES-REE------0",
    "NL": "10YNL----------L",
}

# Lifecycle emission factors in gCO2eq/kWh per ENTSO-E PSR type
# (IPCC AR5 medians, matching Electricity Maps' defaults where available).
# B10 pumped storage naively gets the hydro factor — ignores storage losses.
PSR_EMISSION_FACTORS = {
    "B01": 230.0,  # Biomass
    "B02": 820.0,  # Fossil Brown coal/Lignite
    "B03": 490.0,  # Fossil Coal-derived gas
    "B04": 490.0,  # Fossil Gas
    "B05": 820.0,  # Fossil Hard coal
    "B06": 650.0,  # Fossil Oil
    "B07": 820.0,  # Fossil Oil shale
    "B08": 820.0,  # Fossil Peat
    "B09": 38.0,  # Geothermal
    "B10": 24.0,  # Hydro Pumped Storage
    "B11": 24.0,  # Hydro Run-of-river
    "B12": 24.0,  # Hydro Water Reservoir
    "B13": 17.0,  # Marine
    "B14": 12.0,  # Nuclear
    "B15": 38.0,  # Other renewable
    "B16": 45.0,  # Solar
    "B17": 700.0,  # Waste
    "B18": 12.0,  # Wind Offshore
    "B19": 11.0,  # Wind Onshore
    "B20": 700.0,  # Other
}

RENEWABLE_PSR_TYPES = {"B01", "B09", "B11", "B12", "B13", "B15", "B16", "B18", "B19"}

RESOLUTION_MINUTES = {"PT15M": 15, "PT30M": 30, "PT60M": 60}


class EntsoeFetchConfig(Config):
    region: str = "DE"
    fetch_date: str = ""  # ISO date string, e.g. "2026-07-14"; defaults to yesterday


class IntensitySlot(BaseModel):
    region: str
    timestamp: datetime
    intensity_gco2_kwh: float
    renewable_percentage: float
    source: str = "entsoe"


class GenerationSeries(BaseModel):
    """One parsed TimeSeries: per-slot generated energy (MWh) for one PSR type."""

    psr_type: str
    slot_mwh: list[float]  # SLOTS_PER_DAY entries, aligned to 00:00 UTC


def _localname(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _find(el: ElementTree.Element, name: str) -> ElementTree.Element | None:
    for child in el.iter():
        if _localname(child.tag) == name:
            return child
    return None


def _findall(el: ElementTree.Element, name: str) -> list[ElementTree.Element]:
    return [child for child in el.iter() if _localname(child.tag) == name]


def parse_generation_xml(xml_text: str, day: date) -> list[GenerationSeries]:
    """Parses an A75 GL_MarketDocument into per-PSR-type 96-slot MWh arrays.

    Only generation series (inBiddingZone_Domain) are kept — the "Actual
    Consumption" series for storage pumping (outBiddingZone_Domain) are skipped.
    ENTSO-E omits points whose value repeats the previous position, so gaps are
    forward-filled within each period.
    """
    root = ElementTree.fromstring(xml_text)
    day_start = datetime(day.year, day.month, day.day, tzinfo=UTC)

    series_by_psr: dict[str, list[float]] = {}

    for ts in _findall(root, "TimeSeries"):
        if _find(ts, "outBiddingZone_Domain.mRID") is not None:
            continue  # storage consumption, not generation

        psr_el = _find(ts, "psrType")
        if psr_el is None or not psr_el.text:
            continue
        psr_type = psr_el.text.strip()

        for period in _findall(ts, "Period"):
            res_el = _find(period, "resolution")
            start_el = _find(period, "start")
            if res_el is None or res_el.text not in RESOLUTION_MINUTES:
                continue
            if start_el is None or not start_el.text:
                continue

            res_min = RESOLUTION_MINUTES[res_el.text]
            slots_per_pos = res_min // 15
            period_start = datetime.fromisoformat(start_el.text.replace("Z", "+00:00"))

            # Points come sparse: missing positions repeat the previous value
            points = {
                int(pos.text): float(qty.text)
                for pt in _findall(period, "Point")
                if (pos := _find(pt, "position")) is not None
                and (qty := _find(pt, "quantity")) is not None
                and pos.text and qty.text
            }
            if not points:
                continue

            slot_mwh = series_by_psr.setdefault(psr_type, [0.0] * SLOTS_PER_DAY)
            max_pos = max(points)
            last_mw = 0.0
            for pos in range(1, max_pos + 1):
                last_mw = points.get(pos, last_mw)
                pos_start = period_start + timedelta(minutes=res_min * (pos - 1))
                for sub in range(slots_per_pos):
                    slot_ts = pos_start + timedelta(minutes=15 * sub)
                    slot = int((slot_ts - day_start).total_seconds() // 900)
                    if 0 <= slot < SLOTS_PER_DAY:
                        slot_mwh[slot] += last_mw * 0.25  # MW × 0.25 h = MWh

    return [
        GenerationSeries(psr_type=psr, slot_mwh=mwh) for psr, mwh in sorted(series_by_psr.items())
    ]


def compute_intensity_slots(
    region: str, day: date, series: list[GenerationSeries]
) -> list[IntensitySlot]:
    """Turns per-type generation into per-slot intensity + renewable share.

    Slots with no generation data at all (e.g. publication lag at the end of
    the day) are dropped rather than reported as zero-carbon.
    """
    day_start = datetime(day.year, day.month, day.day, tzinfo=UTC)
    slots: list[IntensitySlot] = []

    for i in range(SLOTS_PER_DAY):
        total_mwh = 0.0
        emitted_g_per_kwh_weighted = 0.0
        renewable_mwh = 0.0

        for s in series:
            mwh = s.slot_mwh[i]
            if mwh <= 0:
                continue
            factor = PSR_EMISSION_FACTORS.get(s.psr_type, PSR_EMISSION_FACTORS["B20"])
            total_mwh += mwh
            emitted_g_per_kwh_weighted += mwh * factor
            if s.psr_type in RENEWABLE_PSR_TYPES:
                renewable_mwh += mwh

        if total_mwh <= 0:
            continue

        slots.append(
            IntensitySlot(
                region=region,
                timestamp=day_start + timedelta(minutes=15 * i),
                intensity_gco2_kwh=round(emitted_g_per_kwh_weighted / total_mwh, 1),
                renewable_percentage=round(renewable_mwh / total_mwh * 100, 1),
            )
        )

    return slots


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10))
def _fetch_generation_xml(eic: str, day: date, api_key: str) -> str:
    """Fetches one UTC day of actual generation per type (A75) as XML."""
    params = {
        "securityToken": api_key,
        "documentType": "A75",
        "processType": "A16",
        "in_Domain": eic,
        "periodStart": day.strftime("%Y%m%d0000"),
        "periodEnd": (day + timedelta(days=1)).strftime("%Y%m%d0000"),
    }
    with httpx.Client(timeout=60) as client:
        resp = client.get(ENTSOE_API_URL, params=params)
        resp.raise_for_status()
        return resp.text


@asset(
    group_name="ingestion",
    description=(
        "Fetches actual generation per production type from ENTSO-E for a "
        "region/date and derives 15-min production-based CO2 intensity. "
        "Overwrites synthetic rows for the same (region, timestamp)."
    ),
    required_resource_keys={"supabase", "entsoe_api_key"},
)
def co2_readings_entsoe(context: AssetExecutionContext, config: EntsoeFetchConfig) -> None:
    api_key: str = context.resources.entsoe_api_key.key
    supabase: SupabaseResource = context.resources.supabase

    eic = REGION_TO_EIC.get(config.region)
    if eic is None:
        raise ValueError(
            f"Unknown region {config.region!r} — supported: {sorted(REGION_TO_EIC)}"
        )

    target_date = (
        date.fromisoformat(config.fetch_date)
        if config.fetch_date
        else date.today() - timedelta(days=1)
    )

    context.log.info(f"Fetching ENTSO-E generation mix for {config.region} / {target_date}")
    xml_text = _fetch_generation_xml(eic, target_date, api_key)
    series = parse_generation_xml(xml_text, target_date)

    if not series:
        context.log.warning("No generation series in response — check region/date/token.")
        return

    slots = compute_intensity_slots(config.region, target_date, series)
    context.log.info(
        f"Parsed {len(series)} production types → {len(slots)} slots with data"
    )

    rows = [
        {
            "region": s.region,
            "timestamp": s.timestamp.isoformat(),
            "intensity_gco2_kwh": s.intensity_gco2_kwh,
            "renewable_percentage": s.renewable_percentage,
            "source": s.source,
        }
        for s in slots
    ]

    supabase.get_client().table("co2_readings").upsert(
        rows, on_conflict="region,timestamp"
    ).execute()
    context.log.info(f"Upserted {len(rows)} ENTSO-E slots for {config.region} / {target_date}")
