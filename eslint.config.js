import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'design-system/**'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-implicit-globals': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: "AssignmentExpression[left.property.name='innerHTML']", message: 'Render with textContent only.' },
      ],
    },
  },
  {
    // Size and complexity limits for app and function code, so CI keeps functions small and readable.
    files: ['docs/**/*.js', 'supabase/**/*.js'],
    rules: {
      complexity: ['error', 10],
      'max-depth': ['error', 3],
      'max-params': ['error', 4],
      'max-statements': ['error', 20],
      'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],
    },
  },
  { files: ['docs/**/*.js'], languageOptions: { globals: { ...globals.browser } } },
  { files: ['test/**/*.js', 'eslint.config.js'], languageOptions: { globals: { ...globals.node } } },
  { files: ['supabase/**/*.js'], languageOptions: { globals: { ...globals.browser, Deno: 'readonly' } } },
];
