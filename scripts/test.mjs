import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'

const testsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests')
const testFiles = readdirSync(testsDir)
  .filter((file) => file.endsWith('.test.mjs'))
  .sort()
  .map((file) => join(testsDir, file))

const result = spawnSync(
  process.execPath,
  ['--test', ...process.argv.slice(2), ...testFiles],
  {
    env: { ...process.env, TZ: 'Australia/Brisbane' },
    stdio: 'inherit',
  },
)

if (result.error) {
  console.error(result.error)
  process.exit(1)
}

process.exit(result.status ?? 1)
