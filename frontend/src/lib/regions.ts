/**
 * Grid regions offered in the UI - the ENTSO-E bidding zones with full
 * history (backfilled since 2026-01-01). The pipeline supports and
 * daily-ingests many more (REGION_TO_EIC in
 * pipeline/pipeline/assets/co2_intensity_entsoe.py); move an entry up from
 * PENDING_REGIONS once it has been backfilled.
 */
export interface Region {
  code: string;
  label: string;
}

export const REGIONS: Region[] = [
  { code: "DE", label: "DE - Germany" },
  { code: "FR", label: "FR - France" },
  { code: "ES", label: "ES - Spain" },
  { code: "NL", label: "NL - Netherlands" },
  { code: "IT-North", label: "IT-North - Italy North" },
  { code: "PL", label: "PL - Poland" },
  { code: "BE", label: "BE - Belgium" },
  { code: "AT", label: "AT - Austria" },
  { code: "CH", label: "CH - Switzerland" },
  { code: "CZ", label: "CZ - Czechia" },
];

/**
 * Supported by the pipeline (validated against ENTSO-E, ingested daily by the
 * 06:00 UTC schedule) but not yet backfilled - history is accumulating a day
 * at a time. Not shown in the UI until they carry enough data for a
 * meaningful "typical day" average.
 */
export const PENDING_REGIONS: Region[] = [
  { code: "BA", label: "BA - Bosnia and Herzegovina" },
  { code: "BG", label: "BG - Bulgaria" },
  { code: "CY", label: "CY - Cyprus" },
  { code: "DK1", label: "DK1 - Denmark West" },
  { code: "DK2", label: "DK2 - Denmark East" },
  { code: "EE", label: "EE - Estonia" },
  { code: "FI", label: "FI - Finland" },
  { code: "GR", label: "GR - Greece" },
  { code: "HR", label: "HR - Croatia" },
  { code: "HU", label: "HU - Hungary" },
  { code: "IE", label: "IE - Ireland" },
  { code: "IT-Calabria", label: "IT-Calabria - Italy Calabria" },
  { code: "IT-Centre-North", label: "IT-Centre-North - Italy Centre North" },
  { code: "IT-Centre-South", label: "IT-Centre-South - Italy Centre South" },
  { code: "IT-Sardinia", label: "IT-Sardinia - Italy Sardinia" },
  { code: "IT-Sicily", label: "IT-Sicily - Italy Sicily" },
  { code: "IT-South", label: "IT-South - Italy South" },
  { code: "LT", label: "LT - Lithuania" },
  { code: "LV", label: "LV - Latvia" },
  { code: "MD", label: "MD - Moldova" },
  { code: "ME", label: "ME - Montenegro" },
  { code: "MK", label: "MK - North Macedonia" },
  { code: "NO1", label: "NO1 - Norway Oslo" },
  { code: "NO2", label: "NO2 - Norway Kristiansand" },
  { code: "NO3", label: "NO3 - Norway Trondheim" },
  { code: "NO4", label: "NO4 - Norway Tromsø" },
  { code: "NO5", label: "NO5 - Norway Bergen" },
  { code: "PT", label: "PT - Portugal" },
  { code: "RO", label: "RO - Romania" },
  { code: "RS", label: "RS - Serbia" },
  { code: "SE1", label: "SE1 - Sweden Luleå" },
  { code: "SE2", label: "SE2 - Sweden Sundsvall" },
  { code: "SE3", label: "SE3 - Sweden Stockholm" },
  { code: "SE4", label: "SE4 - Sweden Malmö" },
  { code: "SI", label: "SI - Slovenia" },
  { code: "SK", label: "SK - Slovakia" },
  { code: "XK", label: "XK - Kosovo" },
];
