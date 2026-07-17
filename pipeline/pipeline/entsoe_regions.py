"""Bidding-zone EIC code mapping shared by every ENTSO-E ingestion asset.

Used by both the A75 generation/CO2-intensity asset and the A44 day-ahead
price asset — the set of supported regions and their EIC codes is the same
regardless of which document type is being fetched for them.
"""

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
