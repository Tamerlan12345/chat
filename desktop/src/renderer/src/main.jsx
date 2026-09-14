import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/theme.css';
import { startThemeClock } from './lib/theme.mjs';

// До первой отрисовки: иначе утром окно на мгновение открывалось тёмным.
startThemeClock();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
