import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['scripts/gate3/*.eval.ts'], environment: 'node', testTimeout: 120_000 }
})
