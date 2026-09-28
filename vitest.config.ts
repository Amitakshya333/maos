import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  test: {
    root: path.resolve(__dirname),
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Several suites exercise intentionally process-global state (model
    // residency, lifecycle files, and launcher children). Force one worker so
    // the default npm test command has the same deterministic isolation as the
    // verified serialized regression run.
    fileParallelism: false,
    maxWorkers: 1,
    // Real offline embedding tests spawn Python and load the pinned transformer
    // model; allow cold starts on slower CI runners.
    testTimeout: 60000,
  },
});
