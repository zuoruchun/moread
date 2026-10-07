import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    css: { include: /src\/renderer\/styles\/.*\.css/ },
    include: ['tests/unit/**/*.{test,spec}.ts'],
    root: path.resolve(__dirname)
  }
});
