import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {initializeFirstAdminBootstrapSecret} from './lib/auth.ts';
import './index.css';

initializeFirstAdminBootstrapSecret();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
