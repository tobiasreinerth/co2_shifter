"""Fetches day-ahead electricity auction prices from the ENTSO-E Transparency
Platform for a region and date range.

API: GET /api?documentType=A44 (day-ahead prices), XML Publication_MarketDocument.
Unlike the A75 generation document, A44 has no PSR types — one price per
15/30/60-min slot per TimeSeries, with in_Domain and out_Domain both set to
the same bidding-zone EIC (day-ahead auction, not a cross-border product).

Not every bidding zone settles in EUR (SE/PL/RO/CZ/HU/BG/DK use their local
currency) — each TimeSeries carries its own currency_Unit.name, which is
stored per row rather than assumed or converted.

DE fix: the current DE-LU zone EIC (10Y1001A1001A83F, correct for A75
generation) has no A44 data on the Transparency Platform under this token —
confirmed via a direct API probe. The pre-2018 combined DE-AT-LU EIC
(10Y1001A1001A82H) does carry current price data under the same token, so
PRICE_EIC_OVERRIDES substitutes it for DE only.

Known gaps (confirmed via a 91-day backfill probe on 2026-07-17): BA, CY,
MD, and XK have no A44 data at all over the full window — plausibly because
they aren't part of the EU's Single Day-Ahead Coupling (SDAC) mechanism.
Same category as REGION_TO_EIC's GB/AL/MT/UA exclusions for A75 — the asset
fails loudly with dagster.Failure rather than silently.
"""

import time
from datetime import UTC, date, datetime, timedelta
from xml.etree import ElementTree

import httpx
from dagster import AssetExecutionContext, Config, Failure, asset
from pydantic import BaseModel
from tenacity import retry, stop_after_attempt, wait_exponential

from pipeline.entsoe_regions import REGION_TO_EIC
from pipeline.entsoe_xml import RESOLUTION_MINUTES, _find, _findall, raise_if_acknowledgement
from pipeline.resources.supabase_resource import SupabaseResource

ENTSOE_API_URL = "https://web-api.tp.entsoe.eu/api"
CHUNK_DAYS = 31  # max days per A44 request — bounds XML size and failure blast radius

# Regions where the A44 price EIC differs from REGION_TO_EIC's generation EIC.
# DE: the current DE-LU zone (10Y1001A1001A83F, correct for A75 generation)
# has no A44 day-ahead price data on the Transparency Platform — verified via
# a direct API probe (2026-07-17). The pre-2018 combined DE-AT-LU zone code
# still carries current price data under the same token, so use it here.
PRICE_EIC_OVERRIDES = {
    "DE": "10Y1001A1001A82H",
}

# slot start (UTC) -> (price per MWh, currency)
PricesByTimestamp = dict[datetime, tuple[float, str]]


class DayAheadPriceFetchConfig(Config):
    """Run config: which region/day to ingest. Empty fetch_date means yesterday.

    Set fetch_end_date to ingest an inclusive date range (backfill); the range
    is fetched in chunks of up to 31 days, and chunks without published data
    are skipped with a warning.
    """

    region: str = "DE"
    fetch_date: str = ""  # ISO date string, e.g. "2026-07-14"; defaults to yesterday
    fetch_end_date: str = ""  # optional inclusive range end; empty = single day


class PriceSlot(BaseModel):
    """One 15-min day_ahead_prices row."""

    region: str
    timestamp: datetime
    price: float
    currency: str
    source: str = "entsoe"


def parse_price_xml(xml_text: str) -> PricesByTimestamp:
    """Parses an A44 Publication_MarketDocument into price-per-MWh by slot start.

    Timestamps are absolute (UTC), so one document may span many days. Like
    the A75 parser, ENTSO-E omits points whose value repeats the previous
    position, so gaps are forward-filled within each period. A document may
    contain multiple TimeSeries (e.g. contract revisions); later ones win for
    any overlapping slot.
    """
    root = ElementTree.fromstring(xml_text)
    prices: PricesByTimestamp = {}

    for ts in _findall(root, "TimeSeries"):
        currency_el = _find(ts, "currency_Unit.name")
        currency = (
            currency_el.text.strip() if currency_el is not None and currency_el.text else "EUR"
        )

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
                int(pos.text): float(amt.text)
                for pt in _findall(period, "Point")
                if (pos := _find(pt, "position")) is not None
                and (amt := _find(pt, "price.amount")) is not None
                and pos.text
                and amt.text
            }
            if not points:
                continue

            max_pos = max(points)
            last_price = 0.0
            for pos in range(1, max_pos + 1):
                last_price = points.get(pos, last_price)
                pos_start = period_start + timedelta(minutes=res_min * (pos - 1))
                for sub in range(slots_per_pos):
                    slot_ts = pos_start + timedelta(minutes=15 * sub)
                    prices[slot_ts] = (last_price, currency)

    return prices


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=10),
    reraise=True,
)
def _fetch_price_xml(eic: str, start: date, end_exclusive: date, api_key: str) -> str:
    """Fetches day-ahead prices (A44) for [start, end_exclusive) as XML.

    Retries transient failures 3× with backoff; HTTP errors include the
    response body snippet because ENTSO-E puts the reason (e.g. bad token)
    in the XML body, not the status line.
    """
    params = {
        "securityToken": api_key,
        "documentType": "A44",
        "in_Domain": eic,
        "out_Domain": eic,
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
        "Fetches day-ahead electricity auction prices from ENTSO-E for a "
        "region and date range and upserts 15-min price rows (native "
        "currency, not converted). Overwrites rows for the same "
        "(region, timestamp)."
    ),
    required_resource_keys={"supabase", "entsoe_api_key"},
)
def day_ahead_prices_entsoe(
    context: AssetExecutionContext, config: DayAheadPriceFetchConfig
) -> None:
    """Ingests ENTSO-E day-ahead prices for one day or an inclusive date range.

    The range is fetched in ≤31-day chunks; chunks ENTSO-E hasn't published
    are skipped with a warning — the run only fails when *no* chunk yields data.
    """
    api_key: str = context.resources.entsoe_api_key.key
    supabase: SupabaseResource = context.resources.supabase

    eic = PRICE_EIC_OVERRIDES.get(config.region) or REGION_TO_EIC.get(config.region)
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

    n_days = (end - start).days + 1
    context.log.info(
        f"Fetching ENTSO-E day-ahead prices for {config.region} / {start}"
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
            total_slots += _ingest_price_chunk(
                context, supabase, api_key, config.region, eic, chunk_start, chunk_end
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


def _ingest_price_chunk(
    context: AssetExecutionContext,
    supabase: SupabaseResource,
    api_key: str,
    region: str,
    eic: str,
    start: date,
    end: date,
) -> int:
    """Fetches, parses, and upserts one region chunk (inclusive date range).

    Returns the upserted slot count. Raises ValueError when ENTSO-E has no
    data for the chunk (acknowledgement document) and Failure when the fetch
    itself fails after retries.
    """
    window_start = datetime(start.year, start.month, start.day, tzinfo=UTC)
    window_end = window_start + timedelta(days=(end - start).days + 1)

    try:
        xml_text = _fetch_price_xml(eic, start, end + timedelta(days=1), api_key)
    except (httpx.HTTPError, RuntimeError) as exc:
        raise Failure(
            description=f"ENTSO-E fetch failed for {region} / {start}…{end}: {exc}"
        ) from exc

    raise_if_acknowledgement(xml_text)
    prices = parse_price_xml(xml_text)

    if not prices:
        context.log.warning(f"No price series for {region} / {start}…{end}.")
        return 0

    slots = [
        PriceSlot(region=region, timestamp=ts, price=price, currency=currency)
        for ts, (price, currency) in prices.items()
        if window_start <= ts < window_end
    ]
    context.log.info(f"{region} / {start}…{end}: {len(slots)} price slots")
    if not slots:
        return 0

    rows = [
        {
            "region": s.region,
            "timestamp": s.timestamp.isoformat(),
            "price": s.price,
            "currency": s.currency,
            "source": s.source,
        }
        for s in slots
    ]

    supabase.upsert_day_ahead_prices(rows)
    return len(rows)
