// src/renderer/main.tsx

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { LocaleProvider } from './i18n/LocaleContext';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </React.StrictMode>,
);
