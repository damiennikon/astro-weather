export const VERIFICATION_SCHEMA_VERSION = 1
export const VERIFICATION_CALCULATION_VERSION = 1
export const FORECAST_PROVIDER = 'open-meteo'
export const BOM_OBSERVATION_PROVIDER = 'bom-aws'
export const BOM_STATION_FEED_BASE = 'https://www.bom.gov.au/fwo/IDQ60901'
export const FORECAST_API_BASE = 'https://api.open-meteo.com/v1/forecast'

export const VERIFICATION_FIELDS = Object.freeze([
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
  'temperature_2m',
  'relative_humidity_2m',
  'dew_point_2m',
  'wind_speed_10m',
])

export const MODEL_FIELDS = Object.freeze({
  ecmwf: [...VERIFICATION_FIELDS, 'wind_speed_250hPa'],
  ukmo: [...VERIFICATION_FIELDS],
  icon: [...VERIFICATION_FIELDS, 'wind_speed_250hPa'],
})

export const MODEL_IDS = Object.freeze({
  ecmwf: 'ecmwf_ifs025',
  ukmo: 'ukmo_seamless',
  icon: 'icon_global',
})

export const OBSERVATION_TOLERANCE_MINUTES = 45
export const RETENTION_DAYS = 400
export const RAW_RETENTION_DAYS = 400
