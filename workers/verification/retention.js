import { RAW_RETENTION_DAYS, RETENTION_DAYS } from './config.js'

export function retentionPlan({ now = new Date(), searchableDays = RETENTION_DAYS, rawDays = RAW_RETENTION_DAYS } = {}) {
  const reference = new Date(now)
  return {
    destructive: true,
    enabled: false,
    approvalRequired: true,
    searchableCutoff: new Date(reference.getTime() - searchableDays * 86_400_000).toISOString(),
    rawCutoff: new Date(reference.getTime() - rawDays * 86_400_000).toISOString(),
    action: 'dry-run only; no records or objects will be deleted',
  }
}

export async function runRetention({ approved = false } = {}) {
  if (!approved) return { deleted: false, reason: 'explicit retention approval is required' }
  throw new Error('Destructive retention is intentionally not enabled in the Stage 5 pilot')
}
