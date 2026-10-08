/**
 * main.tsx
 * --------
 * The actual entry point of the frontend app - this is the first JS that
 * runs in the browser (wired up by index.html, which loads this file as a
 * <script type="module">). All it does is find the empty <div id="root">
 * in index.html and tell React to render our <App /> component into it.
 *
 * <StrictMode> is a React development helper that renders components twice
 * and warns about common mistakes (e.g. side effects in the wrong place) -
 * it has no effect on the production build.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
