import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solid()],
  // Served from https://<user>.github.io/transit-density-mapper/ (GitHub Pages project site).
  base: '/transit-density-mapper/',
  // MapLibre's worker is an ES module (it imports a shared chunk).
  worker: { format: 'es' },
})
