import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// Inter empaquetada — Electron no tiene CSP externa para Google Fonts, así que
// la tipografía va en el bundle (evita depender de la fuente instalada en el SO).
import '@fontsource-variable/inter'
import './assets/css/tailwind.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
