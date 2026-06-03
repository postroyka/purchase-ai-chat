// ESLint flat config (ESLint 9+ / 10+). Replaces the legacy .eslintrc.cjs.
// @nuxt/eslint v1 exposes a flat-config factory that wires Nuxt + Vue + TS
// rules without us hand-rolling parsers.
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(
  {
    ignores: ['.output', '.nuxt', 'node_modules', 'coverage', 'pnpm-lock.yaml'],
  },
  {
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // consistent-type-imports needs the TS parser with type information, which
    // we only configure for .ts files. Applying it to plain .js (commitlint
    // config, etc.) would crash the rule loader.
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports' },
      ],
    },
  },
)
