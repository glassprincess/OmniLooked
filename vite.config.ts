import { defineConfig } from 'vite';

export default defineConfig({
  // Relative paths: the build works from any sub-path (username.github.io/omnilooked/) or a custom domain.
  base: './',
  build: {
    target: 'es2022',
  },
  worker: {
    format: 'es',
  },
});
