CREATE TABLE IF NOT EXISTS verification_runs (
  run_id TEXT PRIMARY KEY,
  scheduled_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  site_count INTEGER NOT NULL,
  model_count INTEGER NOT NULL,
  horizon_days INTEGER NOT NULL,
  scoring_diagnostics TEXT NOT NULL,
  failures_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS forecast_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  collection_run_id TEXT NOT NULL REFERENCES verification_runs(run_id),
  site_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_run_at TEXT,
  retrieved_at TEXT NOT NULL,
  timezone TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  elevation_m REAL,
  grid_latitude REAL,
  grid_longitude REAL,
  grid_elevation_m REAL,
  availability TEXT NOT NULL,
  completeness REAL NOT NULL,
  missing_fields_json TEXT NOT NULL,
  raw_object_key TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  calculation_version INTEGER NOT NULL,
  UNIQUE(collection_run_id, site_id, model)
);

CREATE TABLE IF NOT EXISTS forecast_hours (
  snapshot_id TEXT NOT NULL REFERENCES forecast_snapshots(snapshot_id),
  site_id TEXT NOT NULL,
  model TEXT NOT NULL,
  valid_at TEXT NOT NULL,
  lead_minutes INTEGER,
  retrieval_lead_minutes INTEGER NOT NULL,
  cloud_cover_low REAL,
  cloud_cover_mid REAL,
  cloud_cover_high REAL,
  temperature_2m REAL,
  relative_humidity_2m REAL,
  dew_point_2m REAL,
  wind_speed_10m REAL,
  PRIMARY KEY(snapshot_id, valid_at)
);

CREATE TABLE IF NOT EXISTS ensemble_hours (
  collection_run_id TEXT NOT NULL REFERENCES verification_runs(run_id),
  site_id TEXT NOT NULL,
  ensemble_type TEXT NOT NULL,
  valid_at TEXT NOT NULL,
  retrieval_lead_minutes INTEGER NOT NULL,
  cloud_low REAL,
  cloud_mid REAL,
  cloud_high REAL,
  cloud_total REAL,
  temperature_2m REAL,
  relative_humidity_2m REAL,
  dew_point_2m REAL,
  wind_speed_10m REAL,
  model_cloud_totals_json TEXT NOT NULL,
  model_availability_json TEXT NOT NULL,
  weight_coverage REAL NOT NULL,
  disagreement REAL,
  agreement TEXT,
  confidence TEXT,
  score REAL,
  verdict TEXT,
  score_components_json TEXT,
  missing_data_json TEXT NOT NULL,
  PRIMARY KEY(collection_run_id, site_id, ensemble_type, valid_at)
);

CREATE TABLE IF NOT EXISTS observations (
  observation_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  site_id TEXT NOT NULL,
  station_id TEXT NOT NULL,
  station_name TEXT,
  observed_at TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  temperature_c REAL,
  relative_humidity_pct REAL,
  dew_point_c REAL,
  wind_speed_kmh REAL,
  rainfall_since_9am_mm REAL,
  quality_json TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  UNIQUE(source, station_id, observed_at, site_id)
);

CREATE TABLE IF NOT EXISTS verification_metrics (
  metric_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  site_id TEXT NOT NULL,
  classification TEXT NOT NULL,
  variable TEXT NOT NULL,
  lead_basis TEXT NOT NULL,
  lead_band TEXT,
  hour_of_day INTEGER NOT NULL,
  season TEXT NOT NULL,
  observation_count INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  mae REAL,
  rmse REAL,
  mean_bias REAL,
  median_absolute_error REAL,
  calculation_version INTEGER NOT NULL,
  calculated_at TEXT NOT NULL,
  UNIQUE(model, site_id, variable, lead_basis, lead_band, hour_of_day, season, calculation_version)
);

CREATE INDEX IF NOT EXISTS idx_forecast_hours_site_valid ON forecast_hours(site_id, valid_at);
CREATE INDEX IF NOT EXISTS idx_forecast_hours_model_lead ON forecast_hours(model, lead_minutes);
CREATE INDEX IF NOT EXISTS idx_observations_site_time ON observations(site_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_metrics_model_variable ON verification_metrics(model, variable);
