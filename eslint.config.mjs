import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['dist/**', 'node_modules/**', 'coverage/**', 'examples/*/dist/**']),

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,

  {
    files: ['**/*.ts', '**/*.mts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // ── The core/nestjs boundary ────────────────────────────────────────────────
  // src/core/ must stay framework-agnostic so that extracting it as a standalone
  // @resilient-tx/core package later is a file move, not a refactor. This rule is
  // the enforcement — see docs/adr/0001-async-local-storage.md.
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nestjs/*', '@nestjs/**'],
              message:
                'src/core/ must not import from @nestjs/*. Framework glue belongs in src/nestjs/.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['test/**/*.ts', 'scripts/**/*.mjs', '*.config.ts', '*.config.mts', '*.config.mjs'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },

  {
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
]);
