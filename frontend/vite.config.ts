/**
 * vite.config.ts
 * --------------
 * Configuration for Vite, the build tool/dev server that powers this
 * frontend (fast hot-reload while developing, and bundles everything into
 * static files for deployment - see README.md's Vercel deployment notes).
 * The @vitejs/plugin-react plugin adds support for React's JSX syntax and
 * fast-refresh (components update in the browser without a full page reload).
 */
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
})
