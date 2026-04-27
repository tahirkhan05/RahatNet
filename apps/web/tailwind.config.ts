import type { Config } from 'tailwindcss';
import { baseConfig } from '@rahatnet/config/tailwind';

const config: Config = {
  ...baseConfig,
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
} as Config;

export default config;
