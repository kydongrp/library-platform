import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
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
