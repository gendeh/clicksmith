import React from 'react';
import ReactDOM from 'react-dom/client';
import '../styles/global.css';
import { installVerifyBridge, shouldInstallVerifyBridge } from './verifyBridge';

if (shouldInstallVerifyBridge()) {
  installVerifyBridge();
}

const { default: App } = await import('./App');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
