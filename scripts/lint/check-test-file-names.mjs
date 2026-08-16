// Enforces the one-test-file-per-src-file policy: every
// packages/<pkg>/test/<name>.ts must have a packages/<pkg>/src/<name>.ts.
// Runs as part of `pnpm lint`.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packagesDir = fileURLToPath(new URL('../../packages', import.meta.url))
const violations = []

for (const pkg of readdirSync(packagesDir)) {
    const testDir = join(packagesDir, pkg, 'test')
    if (!existsSync(testDir)) continue
    for (const file of readdirSync(testDir)) {
        if (!file.endsWith('.ts')) continue
        if (!existsSync(join(packagesDir, pkg, 'src', file))) {
            violations.push(`packages/${pkg}/test/${file}`)
        }
    }
}

if (violations.length > 0) {
    console.error(
        'One test file per src file: name each test file after the src file it covers.',
    )
    for (const violation of violations) {
        console.error(`  ${violation} has no matching src file`)
    }
    process.exit(1)
}
