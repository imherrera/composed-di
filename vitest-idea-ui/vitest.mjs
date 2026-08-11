#!/usr/bin/env node
// IDE-only shim: the IntelliJ/WebStorm Vitest runner passes the source
// `.ts` test file it was invoked on as a CLI filter argument. Our
// vitest.config.ts only runs tsc-compiled tests under `dist/test`, so
// that filter never matches anything. Rewrite `packages/<pkg>/test/<name>.ts`
// arguments to their compiled `packages/<pkg>/dist/test/<name>.js` output
// before handing off to the real vitest CLI.
//
// Point the IDE's "Vitest package" setting at this directory (.idea/vitest-ide)
// instead of node_modules/vitest. Plain CLI usage (`pnpm test`) is unaffected.
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const testFilePattern = /^(.*\/packages\/[^/]+)\/test\/(.+)\.ts$/
const rawArgs = process.argv.slice(2)
const rewrittenArgs = []

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i]

  // Redirect through reporter.cjs, which patches the IDE's file-path resolver
  // so test tree nodes navigate back to the .ts source, not the compiled .js.
  if (arg === '--reporter' && rawArgs[i + 1] !== undefined) {
    process.env['_VITEST_IDE_ORIGINAL_REPORTER_PATH'] = resolve(rawArgs[i + 1])
    rewrittenArgs.push('--reporter', resolve(here, 'reporter.cjs'))
    i++
    continue
  }
  const reporterEq = arg.match(/^--reporter=(.+)$/)
  if (reporterEq) {
    process.env['_VITEST_IDE_ORIGINAL_REPORTER_PATH'] = resolve(reporterEq[1])
    rewrittenArgs.push(`--reporter=${resolve(here, 'reporter.cjs')}`)
    continue
  }

  const testFileMatch = arg.match(testFilePattern)
  if (testFileMatch) {
    const [, packageDir, relativeName] = testFileMatch
    const compiled = `${packageDir}/dist/test/${relativeName}.js`
    rewrittenArgs.push(existsSync(compiled) ? compiled : arg)
    continue
  }

  rewrittenArgs.push(arg)
}

process.argv = [process.argv[0], process.argv[1], ...rewrittenArgs]

const realVitestCli = resolve(here, '../node_modules/vitest/vitest.mjs')
await import(realVitestCli)
