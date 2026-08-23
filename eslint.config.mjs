import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // CI runs eslint with --max-warnings 0, so this rule gates the build.
      // The `_` prefix is how this codebase already marks a binding as
      // deliberately unused, and these two cases cannot be written any other
      // way:
      //   - Server actions must accept (prevState, formData) to be usable with
      //     useActionState, even when the action ignores both. That is
      //     argsIgnorePattern.
      //   - `const { secret: _s, ...rest } = obj` is how a field gets omitted
      //     from `rest`. Deleting the binding would silently put the field
      //     back. That is ignoreRestSiblings.
      // Anything genuinely dead still fails, which is the point: the two real
      // dead bindings found when this was turned on were deleted rather than
      // renamed.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Restating the defaults above drops eslint-config-next's own ignores, so
    // these two have to be named explicitly or they get linted as source:
    // `.vercel/output` holds Next's generated CJS launchers, which trip
    // no-require-imports, and its presence depends on whether someone has run
    // `vercel` locally, so lint results differ between a laptop and CI.
    ".vercel/**",
    // Prisma regenerates this on every install; a codegen change upstream
    // should not be able to turn CI red.
    "src/generated/prisma/**",
  ]),
]);

export default eslintConfig;
