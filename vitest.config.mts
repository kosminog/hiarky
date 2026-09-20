import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Many tests drive real subprocesses (git, a python interpreter) in temp
    // projects. Under a parallel run those spawns queue behind each other, so
    // the default 5s timeout fails on contention rather than on a real hang.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
