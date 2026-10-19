// ESLint flat config. Prettier owns formatting; eslint-config-prettier turns off every
// ESLint rule that would fight it. Order matters: later entries override earlier ones.
import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import prettier from 'eslint-config-prettier'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import solid from 'eslint-plugin-solid/configs/typescript'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  { ignores: ['dist/', 'public/data/'] },
  js.configs.recommended,
  // strict: correctness extras (no non-null assertions, no unnecessary conditions, ...).
  // stylistic: consistent idioms (nullish coalescing, interface vs type, array types, ...).
  // Both are type-aware: they read types through the TS project.
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.browser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  { files: ['src/**/*.{ts,tsx}'], ...solid },
  {
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      // Named functions are declarations (`function f() {}`), not `const f = () => {}`.
      // Inline callbacks (`.map((x) => ...)`, `onClick={() => ...}`) may stay arrows.
      'func-style': ['error', 'declaration'],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],

      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'default', format: ['camelCase'] },
        // Module constants may be UPPER_CASE.
        { selector: 'variable', format: ['camelCase', 'UPPER_CASE'] },
        // Solid components are PascalCase functions.
        { selector: 'function', format: ['camelCase', 'PascalCase'] },
        { selector: 'import', format: ['camelCase', 'PascalCase'] },
        { selector: 'typeLike', format: ['PascalCase'] },
        // Property names come from outside: snake_case tile attributes from SQL, and
        // MapLibre style keys like 'line-color'. Don't police them.
        { selector: ['objectLiteralProperty', 'typeProperty'], format: null },
      ],

      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
    },
  },
  // Config files aren't in tsconfig, so skip the type-aware rules for plain JS.
  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
  prettier,
  // `curly` is a "special rule" that eslint-config-prettier turns off; it's compatible
  // with Prettier as long as it's set to "all", so re-enable it after.
  { rules: { curly: ['error', 'all'] } },
)
