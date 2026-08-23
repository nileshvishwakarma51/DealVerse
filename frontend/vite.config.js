import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' makes built asset paths relative, so the SPA works when served
// under the API Gateway stage path (e.g. https://.../prod/).
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    // Inline all assets as data URIs so the Lambda never has to serve binary
    // files through API Gateway (avoids binary-media-type config).
    assetsInlineLimit: 100000000,
  },
});
