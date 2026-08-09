import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite-plus'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root,
  pack: { entry: './lib/index.ts', sourcemap: true, dts: false, format: 'esm' },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
})