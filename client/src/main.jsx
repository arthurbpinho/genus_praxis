import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'

// basename = caminho base do build (import.meta.env.BASE_URL). É '/' no deploy
// full-stack e '/genus_praxis/' no GitHub Pages — necessário para o roteamento
// funcionar sob o subcaminho do Pages.
ReactDOM.createRoot(document.getElementById('root')).render(
  <BrowserRouter basename={import.meta.env.BASE_URL}>
    <App />
  </BrowserRouter>
)
