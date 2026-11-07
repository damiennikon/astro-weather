export const FREE_LIMITS = Object.freeze({
  workersRequestsPerDay: 100_000,
  workersCronTriggersPerAccount: 5,
  d1RowsReadPerDay: 5_000_000,
  d1RowsWrittenPerDay: 100_000,
  // Free D1's per-database limit is 500 MB; 5 GB is the account-wide free
  // storage allowance, not the capacity of this verification database.
  d1StorageBytes: 500 * 1024 ** 2,
  r2StorageBytes: 10 * 1024 ** 3,
  r2ClassARequestsPerMonth: 1_000_000,
  r2ClassBRequestsPerMonth: 10_000_000,
  kvReadsPerDay: 100_000,
  kvWritesPerDay: 1_000,
})

function ratio(value, limit) {
  return limit === 0 ? Infinity : value / limit
}

export function resourceWarnings(usage, limits = FREE_LIMITS) {
  const checks = [
    ['workersRequestsPerDay', usage.workersRequestsPerDay],
    ['d1RowsReadPerDay', usage.d1RowsReadPerDay],
    ['d1RowsWrittenPerDay', usage.d1RowsWrittenPerDay],
    ['d1StorageBytes', usage.d1StorageBytes],
    ['r2StorageBytes', usage.r2StorageBytes],
    ['r2ClassARequestsPerMonth', usage.r2ClassARequestsPerMonth],
    ['r2ClassBRequestsPerMonth', usage.r2ClassBRequestsPerMonth],
    ['kvReadsPerDay', usage.kvReadsPerDay],
    ['kvWritesPerDay', usage.kvWritesPerDay],
  ]
  return checks
    .filter(([, value]) => Number.isFinite(value))
    .map(([resource, value]) => ({
      resource,
      value,
      limit: limits[resource],
      ratio: ratio(value, limits[resource]),
      level: value > limits[resource] ? 'suspend' : value >= limits[resource] * 0.8 ? 'warn' : 'ok',
    }))
}

export function collectionBudget({
  collectionsPerDay = 4,
  modelRequestsPerCollection = 3,
  observationRequestsPerCollection = 6,
  sites = 6,
  horizonHours = 192,
  observationRowsPerSite = 155,
  bytesPerRawResponse = 250_000,
} = {}) {
  const modelRequestsPerDay = collectionsPerDay * modelRequestsPerCollection
  const observationRequestsPerDay = collectionsPerDay * observationRequestsPerCollection
  const forecastHoursPerDay = collectionsPerDay * modelRequestsPerCollection * sites * horizonHours
  const ensembleRowsPerDay = collectionsPerDay * sites * horizonHours * 2
  const observationRowsPerDay = collectionsPerDay * sites * observationRowsPerSite
  const rawBytesPerDay = collectionsPerDay * modelRequestsPerCollection * bytesPerRawResponse
  return {
    collectionsPerDay,
    modelRequestsPerDay,
    observationRequestsPerDay,
    totalExternalRequestsPerDay: modelRequestsPerDay + observationRequestsPerDay,
    forecastHoursPerDay,
    ensembleRowsPerDay,
    observationRowsPerDay,
    estimatedD1RowsPerDay: forecastHoursPerDay + ensembleRowsPerDay + observationRowsPerDay,
    forecastHoursPerMonth: forecastHoursPerDay * 30,
    rawBytesPerDay,
    rawBytesPerMonth: rawBytesPerDay * 30,
  }
}

export function usageFromCounts({ forecastSnapshots = 0, forecastHours = 0, observations = 0, rawObjects = 0, rawBytes = 0 } = {}) {
  return {
    forecastSnapshots,
    forecastHours,
    observations,
    rawObjects,
    rawBytes,
    d1RowsWrittenPerDay: null,
    d1RowsReadPerDay: null,
    d1StorageBytes: null,
    r2StorageBytes: rawBytes,
    r2ClassARequestsPerMonth: rawObjects,
    r2ClassBRequestsPerMonth: null,
    note: 'Counts are local application counters; account-level usage must be checked in Cloudflare Dashboard.',
  }
}
