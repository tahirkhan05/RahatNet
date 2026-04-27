import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals:     true,
    setupFiles:  ['./tests/setup.ts'],
    // Point at the vitest-specific tsconfig so @types/node is available.
    typecheck: {
      tsconfig: './tsconfig.vitest.json',
    },
    include: [
      'tests/unit/**/*.test.ts',
      'tests/unit/**/*.test.tsx',
      'tests/api/**/*.test.ts',
      'tests/api/**/*.test.tsx',
      'tests/hooks/**/*.test.ts',
      'tests/hooks/**/*.test.tsx',
      'tests/components/**/*.test.tsx',
      'tests/components/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: [
        'lib/**/*.ts',
        'lib/**/*.tsx',
        'hooks/**/*.ts',
        'components/**/*.tsx',
        'app/api/**/*.ts',
      ],
      exclude: [
        'node_modules/**',
        '.next/**',
        'tests/**',
        '**/*.config.*',
        '**/*.d.ts',
        '**/types/**',
        '**/__mocks__/**',
      ],
      thresholds: {
        lines:      80,
        functions:  80,
        branches:   80,
        statements: 80,
      },
    },
  },
  resolve: {
    alias: {
      '@':               process.cwd(),
      '@rahatnet/types': process.cwd() + '/../../packages/types/src/index.ts',
      '@rahatnet/ui':    process.cwd() + '/../../packages/ui/src/index.ts',
    },
  },
});
