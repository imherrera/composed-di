import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Run the tsc-compiled tests, not their sources. `pnpm build` emits these
    // next to the compiled library, so `../src/*.js` resolves to `dist/src`
    // at runtime and vitest performs no TypeScript transformation of its own.
    include: ['packages/*/dist/test/**/*.js'],
  },
})
