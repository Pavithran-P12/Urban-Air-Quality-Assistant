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
  { files: ['docs/**/*.js'], languageOptions: { globals: { ...globals.browser } } },
  { files: ['test/**/*.js', 'eslint.config.js'], languageOptions: { globals: { ...globals.node } } },
  { files: ['supabase/**/*.js'], languageOptions: { globals: { ...globals.browser, Deno: 'readonly' } } },
];
