import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const sourceEntry = (packageName: string) =>
  fileURLToPath(
    new URL(`packages/${packageName}/src/index.ts`, import.meta.url),
  )

export default defineConfig({
  test: {
    globals: true,
    include: ['packages/*/test/**/*.ts'],
  },
  resolve: {
    // Resolve workspace packages to their sources so tests never depend
    // on build output.
    alias: {
      '@composed-di/core': sourceEntry('core'),
      '@composed-di/decorators': sourceEntry('decorators'),
      '@composed-di/instrumentation-core': sourceEntry('instrumentation-core'),
      '@composed-di/instrumentation-otel': sourceEntry('instrumentation-otel'),
    },
  },
})
