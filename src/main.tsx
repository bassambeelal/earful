import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './app.css'
import './lib/install'
import { applyTheme } from './lib/theme'
import App from './App.tsx'

// Set the theme before the first paint so there is no flash of the wrong colours.
applyTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
