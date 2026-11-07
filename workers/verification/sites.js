// Fixed, non-user reference sites for the controlled Stage 5 pilot.
// Coordinates describe the forecast point; observations are deliberately kept as
// a separate station record because a nearby AWS is not the same location.

export const REFERENCE_SITES = Object.freeze([
  {
    id: 'loganholme',
    name: 'Loganholme',
    latitude: -27.682,
    longitude: 153.184,
    elevationM: 18,
    classification: 'urban',
    observationStationId: '040211',
    observationStationName: 'ARCHERFIELD AIRPORT',
    observationFeedId: '94575',
  },
  {
    id: 'cedar-grove',
    name: 'Cedar Grove',
    latitude: -27.856,
    longitude: 152.984,
    elevationM: 73,
    classification: 'inland',
    observationStationId: '040983',
    observationStationName: 'BEAUDESERT DRUMLEY STREET',
    observationFeedId: '95575',
  },
  {
    id: 'brisbane-airport',
    name: 'Brisbane Airport',
    latitude: -27.394,
    longitude: 153.129,
    elevationM: 4,
    classification: 'coastal',
    observationStationId: '040842',
    observationStationName: 'BRISBANE AERO',
    observationFeedId: '94578',
  },
  {
    id: 'gold-coast',
    name: 'Gold Coast Seaway',
    latitude: -27.940,
    longitude: 153.430,
    elevationM: 3,
    classification: 'coastal',
    observationStationId: '040764',
    observationStationName: 'GOLD COAST SEAWAY',
    observationFeedId: '94580',
  },
  {
    id: 'warwick',
    name: 'Warwick',
    latitude: -28.210,
    longitude: 152.100,
    elevationM: 475,
    classification: 'inland',
    observationStationId: '041525',
    observationStationName: 'WARWICK',
    observationFeedId: '94555',
  },
  {
    id: 'scenic-rim',
    name: 'Scenic Rim / Canungra',
    latitude: -28.040,
    longitude: 153.190,
    elevationM: 108,
    classification: 'elevated',
    observationStationId: '140008',
    observationStationName: 'CANUNGRA (DEFENCE)',
    observationFeedId: '94418',
  },
])

export const SITE_TIMEZONE = 'Australia/Brisbane'
export const PILOT_HORIZON_DAYS = 8
export const COLLECTIONS_PER_DAY = 4

export function siteById(siteId, sites = REFERENCE_SITES) {
  const site = sites.find((candidate) => candidate.id === siteId)
  if (!site) throw new Error(`Unknown verification site: ${siteId}`)
  return site
}
