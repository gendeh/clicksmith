import React from 'react';
import ReactDOM from 'react-dom/client';
import '../styles/global.css';
import { installVerifyBridge, shouldInstallVerifyBridge } from './verifyBridge';
import App from './App';

if (import.meta.env.VITE_CLICKSMITH_VERIFY === 'true' && shouldInstallVerifyBridge()) {
  installVerifyBridge();
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
