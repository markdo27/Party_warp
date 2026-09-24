import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Relative asset URLs, so the build works from a GitHub Pages sub-path.
  base: './',
  plugins: [react(), tailwindcss()],
  // A launcher can assign the dev port through PORT; --port on the command line still wins.
  server: { port: Number(process.env.PORT) || 5173 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{js,jsx}'],
    coverage: {
      include: ['src/**/*.{js,jsx}'],
      exclude: ['src/main.jsx', 'src/**/*.test.{js,jsx}'],
    },
  },
});
