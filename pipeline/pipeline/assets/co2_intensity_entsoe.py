"""Fetches actual generation per production type from the ENTSO-E Transparency
Platform and derives 15-min CO2 intensity for a region and date range.

Approach: production-based intensity. For each 15-min slot, the grid intensity
is the generation-weighted mean of per-technology lifecycle emission factors:

    intensity[slot] = Σ(gen_type_mwh × factor_g_per_kwh) / Σ(gen_type_mwh)

Emission factors are loaded from the Supabase `emission_factors` table at the
start of every run (source of truth — edit there, next ingest uses it). This
ignores imports/exports (consumption-based accounting would require
cross-border flow tracing). Renewable % is the renewable share of generation;
the full per-source mix is stored as JSONB alongside each reading.

API: GET /api?documentType=A75&processType=A16 (actual generation per type),
XML GL_MarketDocument. Quantities are MW averaged over the period resolution.
Ranges are fetched in chunks of up to 31 days per request.
"""

import time
from datetime import UTC, date, datetime, timedelta
from xml.etree import ElementTree

import httpx
from dagster import AssetExecutionContext, Config, Failure, asset
from pydantic import BaseModel
from tenacity import retry, stop_after_attempt, wait_exponential

from pipeline.resources.supabase_resource import EmissionFactor, SupabaseResource

SLOTS_PER_DAY = 96  # 24h × 4
ENTSOE_API_URL = "https://web-api.tp.entsoe.eu/api"
CHUNK_DAYS = 31  # max days per A75 request — bounds XML size and failure blast radius

# Bidding-zone EIC codes offered as regions. Multi-zone countries (DK, NO, SE,
# IT) appear per zone — ENTSO-E publishes no national feed for them.
# No GB: stopped publishing to ENTSO-E 2021-06-15 (post-Brexit TCA);
# use Elexon BMRS or carbonintensity.org.uk if GB support is needed.
# No AL/MT/UA: valid EICs but no A75 generation data published (probed 2026-07-16).
REGION_TO_EIC = {
    "AT": "10YAT-APG------L",  # Austria
    "BA": "10YBA-JPCC-----D",  # Bosnia and Herzegovina
    "BE": "10YBE----------2",  # Belgium
    "BG": "10YCA-BULGARIA-R",  # Bulgaria
    "CH": "10YCH-SWISSGRIDZ",  # Switzerland
    "CY": "10YCY-1001A0003J",  # Cyprus
    "CZ": "10YCZ-CEPS-----N",  # Czechia
    "DE": "10Y1001A1001A83F",  # Germany (DE-LU bidding zone)
    "DK1": "10YDK-1--------W",  # Denmark West
    "DK2": "10YDK-2--------M",  # Denmark East
    "EE": "10Y1001A1001A39I",  # Estonia
    "ES": "10YES-REE------0",  # Spain
    "FI": "10YFI-1--------U",  # Finland
    "FR": "10YFR-RTE------C",  # France
    "GR": "10YGR-HTSO-----Y",  # Greece
    "HR": "10YHR-HEP------M",  # Croatia
    "HU": "10YHU-MAVIR----U",  # Hungary
    "IE": "10Y1001A1001A59C",  # Ireland (SEM)
    "IT-Calabria": "10Y1001C--00096J",
    "IT-Centre-North": "10Y1001A1001A70O",
    "IT-Centre-South": "10Y1001A1001A71M",
    "IT-North": "10Y1001A1001A73I",
    "IT-Sardinia": "10Y1001A1001A74G",
    "IT-Sicily": "10Y1001A1001A75E",
    "IT-South": "10Y1001A1001A788",
    "LT": "10YLT-1001A0008Q",  # Lithuania
    "LV": "10YLV-1001A00074",  # Latvia
    "MD": "10Y1001A1001A990",  # Moldova
    "ME": "10YCS-CG-TSO---S",  # Montenegro
    "MK": "10YMK-MEPSO----8",  # North Macedonia
    "NL": "10YNL----------L",  # Netherlands
    "NO1": "10YNO-1--------2",  # Norway Oslo
    "NO2": "10YNO-2--------T",  # Norway Kristiansand
    "NO3": "10YNO-3--------J",  # Norway Trondheim
    "NO4": "10YNO-4--------9",  # Norway Tromsø
    "NO5": "10Y1001A1001A48H",  # Norway Bergen
    "PL": "10YPL-AREA-----S",  # Poland
    "PT": "10YPT-REN------W",  # Portugal
    "RO": "10YRO-TEL------P",  # Romania
    "RS": "10YCS-SERBIATSOV",  # Serbia
    "SE1": "10Y1001A1001A44P",  # Sweden Luleå
    "SE2": "10Y1001A1001A45N",  # Sweden Sundsvall
    "SE3": "10Y1001A1001A46L",  # Sweden Stockholm
    "SE4": "10Y1001A1001A47J",  # Sweden Malmö
    "SI": "10YSI-ELES-----O",  # Slovenia
    "SK": "10YSK-SEPS-----K",  # Slovakia
    "XK": "10Y1001C--00100H",  # Kosovo
}

RESOLUTION_MINUTES = {"PT15M": 15, "PT30M": 30, "PT60M": 60}

# psr_type -> {slot start (UTC) -> generated MWh}
GenerationByType = dict[str, dict[datetime, float]]


class EntsoeFetchConfig(Config):
    """Run config: which region/day to ingest. Empty fetch_date means yesterday.

    Set fetch_end_date to ingest an inclusive date range (backfill); the range
    is fetched in chunks of up to 31 days, and chunks without published data
    are skipped with a warning.
    """

    region: str = "DE"
    fetch_date: str = ""  # ISO date string, e.g. "2026-07-14"; defaults to yesterday
    fetch_end_date: str = ""  # optional inclusive range end; empty = single day


class IntensitySlot(BaseModel):
    """One 15-min co2_readings row derived from the generation mix."""

    region: str
    timestamp: datetime
    intensity_gco2_kwh: float
    renewable_percentage: float
    generation_mix: dict[str, float]  # source_name -> share % of generation
    source: str = "entsoe"


def _localname(tag: str) -> str:
    """Strips the XML namespace from a tag ('{ns}Point' → 'Point')."""
    return tag.rsplit("}", 1)[-1]


def _find(el: ElementTree.Element, name: str) -> ElementTree.Element | None:
    """Returns the first descendant with the given namespace-free tag name."""
    for child in el.iter():
        if _localname(child.tag) == name:
            return child
    return None


def _findall(el: ElementTree.Element, name: str) -> list[ElementTree.Element]:
    """Returns all descendants with the given namespace-free tag name."""
    return [child for child in el.iter() if _localname(child.tag) == name]


def raise_if_acknowledgement(xml_text: str) -> None:
    """Raises if the response is an Acknowledgement_MarketDocument.

    ENTSO-E answers HTTP 200 with an acknowledgement document instead of data
    when a query is valid but yields nothing (future date, wrong EIC, no
    publication yet). Surface its Reason text instead of parsing zero series.
    """
    try:
        root = ElementTree.fromstring(xml_text)
    except ElementTree.ParseError as exc:
        raise ValueError(f"ENTSO-E returned unparseable XML: {exc}") from exc
    if _localname(root.tag) != "Acknowledgement_MarketDocument":
        return
    reason_el = _find(root, "text")
    reason = (
        reason_el.text.strip() if reason_el is not None and reason_el.text else "no reason given"
    )
    raise ValueError(f"ENTSO-E returned no data: {reason}")


def parse_generation_xml(xml_text: str) -> GenerationByType:
    """Parses an A75 GL_MarketDocument into per-PSR-type MWh keyed by slot start.

    Timestamps are absolute (UTC), so one document may span many days. Only
    generation series (inBiddingZone_Domain) are kept — the "Actual
    Consumption" series for storage pumping (outBiddingZone_Domain) are
    skipped. ENTSO-E omits points whose value repeats the previous position,
    so gaps are forward-filled within each period.
    """
    root = ElementTree.fromstring(xml_text)
    generation: GenerationByType = {}

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

            slot_mwh = generation.setdefault(psr_type, {})
            max_pos = max(points)
            last_mw = 0.0
            for pos in range(1, max_pos + 1):
                last_mw = points.get(pos, last_mw)
                pos_start = period_start + timedelta(minutes=res_min * (pos - 1))
                for sub in range(slots_per_pos):
                    slot_ts = pos_start + timedelta(minutes=15 * sub)
                    slot_mwh[slot_ts] = slot_mwh.get(slot_ts, 0.0) + last_mw * 0.25

    return generation


def compute_intensity_slots(
    region: str, generation: GenerationByType, factors: dict[str, EmissionFactor]
) -> list[IntensitySlot]:
    """Turns per-type generation into per-slot intensity, renewable share, and mix.

    Iterates the union of timestamps present in the data — slots nothing was
    published for simply don't appear (e.g. publication lag at the range end).
    Unknown PSR types fall back to the "B20" (other) factor row.
    """
    fallback = factors["B20"]
    all_ts = sorted({ts for slots in generation.values() for ts in slots})
    result: list[IntensitySlot] = []

    for ts in all_ts:
        total_mwh = 0.0
        weighted_g_per_kwh = 0.0
        renewable_mwh = 0.0
        mix_mwh: dict[str, float] = {}

        for psr_type, slots in generation.items():
            mwh = slots.get(ts, 0.0)
            if mwh <= 0:
                continue
            factor = factors.get(psr_type, fallback)
            total_mwh += mwh
            weighted_g_per_kwh += mwh * factor.factor_gco2eq_per_kwh
            if factor.is_renewable:
                renewable_mwh += mwh
            mix_mwh[factor.source_name] = mix_mwh.get(factor.source_name, 0.0) + mwh

        if total_mwh <= 0:
            continue

        mix_pct = {
            name: pct
            for name, mwh in sorted(mix_mwh.items())
            if (pct := round(mwh / total_mwh * 100, 1)) > 0
        }
        result.append(
            IntensitySlot(
                region=region,
                timestamp=ts,
                intensity_gco2_kwh=round(weighted_g_per_kwh / total_mwh, 1),
                renewable_percentage=round(renewable_mwh / total_mwh * 100, 1),
                generation_mix=mix_pct,
            )
        )

    return result


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=10),
    reraise=True,
)
def _fetch_generation_xml(eic: str, start: date, end_exclusive: date, api_key: str) -> str:
    """Fetches actual generation per type (A75) for [start, end_exclusive) as XML.

    Retries transient failures 3× with backoff; HTTP errors include the
    response body snippet because ENTSO-E puts the reason (e.g. bad token)
    in the XML body, not the status line.
    """
    params = {
        "securityToken": api_key,
        "documentType": "A75",
        "processType": "A16",
        "in_Domain": eic,
        "periodStart": start.strftime("%Y%m%d0000"),
        "periodEnd": end_exclusive.strftime("%Y%m%d0000"),
    }
    with httpx.Client(timeout=120) as client:
        resp = client.get(ENTSOE_API_URL, params=params)
        try:
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(
                f"ENTSO-E request failed with HTTP {resp.status_code}: {resp.text[:300]}"
            ) from exc
        return resp.text


@asset(
    group_name="ingestion",
    description=(
        "Fetches actual generation per production type from ENTSO-E for a "
        "region and date range and derives 15-min production-based CO2 "
        "intensity plus the per-source generation mix. Emission factors are "
        "read from the emission_factors table each run. Overwrites rows for "
        "the same (region, timestamp)."
    ),
    required_resource_keys={"supabase", "entsoe_api_key"},
)
def co2_readings_entsoe(context: AssetExecutionContext, config: EntsoeFetchConfig) -> None:
    """Ingests ENTSO-E-derived CO2 intensity for one day or an inclusive date range.

    The range is fetched in ≤31-day chunks; chunks ENTSO-E hasn't published
    are skipped with a warning — the run only fails when *no* chunk yields data.
    """
    api_key: str = context.resources.entsoe_api_key.key
    supabase: SupabaseResource = context.resources.supabase

    eic = REGION_TO_EIC.get(config.region)
    if eic is None:
        raise ValueError(
            f"Unknown region {config.region!r} — supported: {sorted(REGION_TO_EIC)}"
        )

    start = (
        date.fromisoformat(config.fetch_date)
        if config.fetch_date
        else date.today() - timedelta(days=1)
    )
    end = date.fromisoformat(config.fetch_end_date) if config.fetch_end_date else start
    if end < start:
        raise ValueError(f"fetch_end_date {end} is before fetch_date {start}")

    factors = supabase.fetch_emission_factors()
    context.log.info(f"Loaded {len(factors)} emission factors from Supabase")

    n_days = (end - start).days + 1
    context.log.info(
        f"Fetching ENTSO-E generation mix for {config.region} / {start}"
        + (f" … {end} ({n_days} days)" if n_days > 1 else "")
    )

    total_slots = 0
    skipped: list[str] = []
    chunk_start = start
    while chunk_start <= end:
        chunk_end = min(chunk_start + timedelta(days=CHUNK_DAYS - 1), end)
        if chunk_start != start:
            time.sleep(0.2)  # stay well under ENTSO-E's 400 requests/min limit
        try:
            total_slots += _ingest_chunk(
                context, supabase, api_key, config.region, eic, chunk_start, chunk_end, factors
            )
        except ValueError as exc:
            # No data published for this chunk — expected near "now" and in gaps
            context.log.warning(f"Skipping {config.region} / {chunk_start}…{chunk_end}: {exc}")
            skipped.append(f"{chunk_start}…{chunk_end}: {exc}")
        chunk_start = chunk_end + timedelta(days=1)

    if skipped and total_slots == 0:
        raise Failure(
            description=(
                f"No data for any requested chunk ({n_days} day(s)) for {config.region} — "
                f"first skip reason: {skipped[0]}"
            )
        )

    context.log.info(
        f"Done: upserted {total_slots} slots for {config.region} over {n_days} day(s)"
        + (f", skipped {len(skipped)} chunk(s) without data" if skipped else "")
    )


def _ingest_chunk(
    context: AssetExecutionContext,
    supabase: SupabaseResource,
    api_key: str,
    region: str,
    eic: str,
    start: date,
    end: date,
    factors: dict[str, EmissionFactor],
) -> int:
    """Fetches, derives, and upserts one region chunk (inclusive date range).

    Returns the upserted slot count. Raises ValueError when ENTSO-E has no
    data for the chunk (acknowledgement document) and Failure when the fetch
    itself fails after retries.
    """
    window_start = datetime(start.year, start.month, start.day, tzinfo=UTC)
    window_end = window_start + timedelta(days=(end - start).days + 1)

    try:
        xml_text = _fetch_generation_xml(eic, start, end + timedelta(days=1), api_key)
    except (httpx.HTTPError, RuntimeError) as exc:
        raise Failure(
            description=f"ENTSO-E fetch failed for {region} / {start}…{end}: {exc}"
        ) from exc

    raise_if_acknowledgement(xml_text)
    generation = parse_generation_xml(xml_text)

    if not generation:
        context.log.warning(f"No generation series for {region} / {start}…{end}.")
        return 0

    slots = [
        s
        for s in compute_intensity_slots(region, generation, factors)
        if window_start <= s.timestamp < window_end
    ]
    context.log.info(
        f"{region} / {start}…{end}: {len(generation)} production types → {len(slots)} slots"
    )
    if not slots:
        return 0

    rows = [
        {
            "region": s.region,
            "timestamp": s.timestamp.isoformat(),
            "intensity_gco2_kwh": s.intensity_gco2_kwh,
            "renewable_percentage": s.renewable_percentage,
            "generation_mix": s.generation_mix,
            "source": s.source,
        }
        for s in slots
    ]

    supabase.upsert_co2_readings(rows)
    return len(rows)
