import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { GrantApp } from './GrantApp';
import './grant.css';

const el = document.getElementById('root');
if (!el) throw new Error('missing #root');
createRoot(el).render(
  <StrictMode>
    <GrantApp />
  </StrictMode>,
);
