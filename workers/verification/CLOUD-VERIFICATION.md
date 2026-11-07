# Cloud verification feasibility plan

This document is part of the Stage 5 pilot implementation. It does not add a
satellite collector and does not change AstroWeather's production forecast.

## What can be measured

The current model fields are deterministic cloud fractions by low, middle, and
high layer. They are not probabilities. A satellite product would be a separate
observation of cloud presence or cloud fraction, not a direct measurement of
astrophotography quality.

The three concepts must remain separate:

1. **Satellite cloud detection:** a pixel or area classified as cloud-covered.
2. **Model cloud fraction:** the forecast fraction for a model layer/grid cell.
3. **Observing quality:** whether the sky is sufficiently transparent and stable
   for the intended astronomical observation.

## BOM/Himawari product path

BOM publishes Himawari-derived satellite products sourced from the Advanced
Himawari Imager. The registered-user catalogue includes a 2 km full-disk cloud
cover product in GeoTIFF form. Anonymous JPEG imagery is useful for visual review,
but is not an appropriate quantitative verification input without a documented
classification and calibration step.

Reference: [BOM satellite GeoTIFF product guide](https://www.bom.gov.au/catalogue/satellite_geotiff.pdf)
and [BOM satellite image product guide](https://www.bom.gov.au/catalogue/Bureau_of_Meteorology_satellite_images_JPG_format_user_guide.pdf).

## Proposed future adapter

The adapter should be a separate ingestion job with these stages:

1. Download the specific product for a fixed valid timestamp.
2. Preserve the original file in R2 with product version, acquisition time, and
   checksum metadata.
3. Decode the GeoTIFF and its geospatial metadata.
4. Reproject or sample the pixels around each reference site.
5. Store an area statistic such as median cloud fraction, interquartile range,
   valid-pixel count, and quality flags.
6. Match the satellite timestamp to the forecast valid hour using an explicit
   tolerance window.
7. Verify low/mid/high model fields only when the product genuinely supports the
   corresponding layer interpretation; otherwise report total cloud only.

## Scientific limitations

- Geostationary satellite pixels observe cloud from above, while an observer
  cares about the line of sight from the ground.
- Parallax shifts high cloud away from its apparent ground position. The adapter
  must preserve the uncorrected product location and record any parallax method
  separately.
- Thin cirrus, fog, smoke, haze, and optically thin cloud can be classified
  differently from what affects visual observing.
- Night-time detection may use infrared channels and will not have the same
  behaviour as daytime visible imagery.
- A station point is not equivalent to a 2 km pixel or a surrounding area.
- Cloud fraction is not the same as transparency, seeing, or a usable
  astrophotography window.

## Cost and access assessment

The main cost risks are registered BOM access, transfer/storage of repeated raster
files, and CPU time for GeoTIFF decoding. A single six-site extraction should be
cheaper than archiving full-disk imagery, but that choice must be checked against
the product licence and reproducibility requirements.

The Stage 5 pilot therefore archives all forecast cloud layers but does not fetch
satellite data. A future implementation should begin with a short offline sample
of one product type and one SEQ day, validate the geospatial and timestamp logic,
and obtain separate approval before adding a scheduled satellite job.

## Free-tier boundary

The pilot is sized for four scheduled collections per day: 12 Open-Meteo model
requests and 24 BOM station requests per day. One collection writes three raw
R2 objects and uses D1 `batch()` calls capped at 1,000 statements, so the D1
calls remain well below the Workers Free 50-subrequest limit when combined with
the nine external fetches, R2 writes and KV state operations. Cloudflare's D1
Free limit is 500 MB per database, and the 10 ms CPU limit remains an unverified
operational risk because only a deployed Cloudflare invocation can measure it.

The existing AstroWeather scheduler is outside this worker but shares the
account-level Workers request, cron-trigger and KV allowances. Its live
subscriber count and account usage were not available for this read-only review,
so the four additional cron runs per day must be checked against the account
dashboard before enabling collection.

## Recommended decision

Do not use satellite data as a cloud “ground truth” until the product's access,
licence, layer semantics, nighttime performance, and spatial matching have been
validated. Until then, publish surface-variable verification separately and label
cloud verification as unavailable rather than substituting a different forecast
provider or a manual estimate.
