import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["test/**/*.test.ts"],
        setupFiles: ["test/setup-env.ts"],
        // Each test file gets its own in-memory Postgres (PGlite); files run in parallel
        pool: "forks",
        testTimeout: 30_000,
        hookTimeout: 60_000,
    },
});
