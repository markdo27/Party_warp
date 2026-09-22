import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import RetroStickerWarp from './RetroStickerWarp.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RetroStickerWarp />
  </StrictMode>,
);
