import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    fileParallelism: false,
    include: ['tests/**/*.test.js'],
    globalSetup: ['tests/create-test-db.js'],
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL?.replace(/\/draft$/, '/draft_test') || 'postgresql://draft:draft@localhost:5432/draft_test',
    },
  },
})
