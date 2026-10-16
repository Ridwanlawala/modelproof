import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Relative base: the same build works on GitHub Pages (/modelproof/), any static host, or an Arweave/IPFS path.
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icon-512.png'],
      manifest: {
        name: 'ModelProof: verifiable AI model provenance',
        short_name: 'ModelProof',
        description: 'Hash, sign and permanently publish AI model provenance manifests on Arweave. Verify any copy offline.',
        theme_color: '#0b1020', background_color: '#0b1020', display: 'standalone', start_url: './', scope: './',
        icons: [
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: { globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'], navigateFallback: 'index.html' },
    }),
  ],
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as never);
