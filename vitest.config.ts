import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['packages/*/test/**/*.ts'],
  },
  resolve: {
    // Tests read as `src` imports but execute the compiled output, so what is
    // verified is what is published. `dist` mirrors `src` file for file, so
    // unexported internals stay reachable.
    alias: [{ find: /^\.\.\/src\/(.*)$/, replacement: '../dist/$1' }],
  },
})
