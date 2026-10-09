import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests spawn mock App Server / MCP child processes and wait on
    // real process + WS round trips, so give them room.
    testTimeout: 90_000,
    hookTimeout: 90_000,
    fileParallelism: false,
  },
});
