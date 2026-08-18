#!/usr/bin/env node

import { main } from '../src/main.mjs';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unexpected failure';
  process.stderr.write(`provenex-check: ${message}\n`);
  process.exitCode = error?.exitCode === 2 ? 2 : 3;
}
