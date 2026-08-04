module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ['dist', 'node_modules', '.turbo'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
  },
  // Planwise dark-mode guardrail lives in `scripts/check-dark-mode.mjs`
  // instead of ESLint — it's class-list-aware (only flags UNPAIRED
  // slate/gray/bg-white classes, not the ones already partnered with
  // a `dark:` variant), which a plain no-restricted-syntax rule can't
  // express. Wire it into CI or run `pnpm check:dark-mode` locally.
};
