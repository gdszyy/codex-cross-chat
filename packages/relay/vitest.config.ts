import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Contract tests open real sockets and embedded Postgres; on a loaded
    // machine a single case can exceed the 5s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
