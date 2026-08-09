import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['packages/*/test/**/*.ts'],
  },
  resolve: {
    // Resolve workspace packages to their sources so tests never depend
    // on build output.
    alias: {
      '@composed-di/core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@composed-di/decorators': resolve(
        __dirname,
        'packages/decorators/src/index.ts',
      ),
      '@composed-di/instrumentation-core': resolve(
        __dirname,
        'packages/instrumentation-core/src/index.ts',
      ),
      '@composed-di/instrumentation-otel': resolve(
        __dirname,
        'packages/instrumentation-otel/src/index.ts',
      ),
    },
  },
})
