import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

// https://vite.dev/config/
export default defineConfig({
  define: {
    // Stamped automatically every real build (local or GitHub Actions) - no manual
    // version bumping needed. Read as __BUILD_TIME__ in the app, shown in the footer.
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    // Read straight from package.json's "version" field at build time - bump that
    // field when shipping a change, and this picks it up automatically.
    __BUILD_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Court Call',
        short_name: 'Court Call',
        description: 'Weekly tennis pairing sheet',
        theme_color: '#1E5631',
        background_color: '#F6F7F4',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
})
