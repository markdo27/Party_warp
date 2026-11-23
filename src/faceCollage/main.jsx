import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import FaceCollageApp from './FaceCollageApp.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <FaceCollageApp />
  </StrictMode>,
);
