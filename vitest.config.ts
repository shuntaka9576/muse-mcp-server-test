import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'apps/**/*.test.ts',
      'iac/aws/test/**/*.test.ts',
      'tools/**/*.test.ts',
    ],
  },
});
