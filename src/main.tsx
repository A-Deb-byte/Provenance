import {StrictMode, useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {initializeFirstAdminBootstrapSecret} from './lib/auth.ts';
import {reportNativeAcceptanceMount} from './runtime/nativeAcceptanceMount.ts';
import './index.css';

initializeFirstAdminBootstrapSecret();

const NativeAcceptanceMountReporter = () => {
  useEffect(() => {
    void reportNativeAcceptanceMount();
  }, []);
  return null;
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <NativeAcceptanceMountReporter />
    <App />
  </StrictMode>,
);
