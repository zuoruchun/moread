import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.{test,spec}.ts'],
    root: path.resolve(__dirname)
  }
});
