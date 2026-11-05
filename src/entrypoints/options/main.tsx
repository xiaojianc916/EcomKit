import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OptionsApp } from './OptionsApp';
import './options.css';

const el = document.getElementById('root');
if (!el) throw new Error('missing #root');
createRoot(el).render(
  <StrictMode>
    <OptionsApp />
  </StrictMode>,
);
