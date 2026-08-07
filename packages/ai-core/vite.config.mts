import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite-plus'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  pack: {
    dts: { tsconfig: './tsconfig.app.json', sourcemap: true },
    sourcemap: true,
    entry: './lib/index.ts',

    alias: { '@': './lib' },
  },
  root,
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
})