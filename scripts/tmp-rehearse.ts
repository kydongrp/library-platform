/**
 * Dress rehearsal for `neon:move -- sync`: builds a throwaway target on the
 * same server, writes .env.migration at it, and hands back the command to run.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { connectionString } from "./lib/dump";

function withDatabase(url: string, db: string) { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); }

void (async () => {
  const live = connectionString();
  const db = `dls_rehearse_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: withDatabase(live, "postgres") });
  admin.on("error", () => {});
  await admin.connect();
  await admin.query(`CREATE DATABASE "${db}"`);
  await admin.end();
  const url = withDatabase(live, db);
  execFileSync(process.execPath, [resolve("node_modules/prisma/build/index.js"), "db", "push", "--accept-data-loss"], {
    env: { ...process.env, DATABASE_URL: url, POSTGRES_URL_NON_POOLING: url, DATABASE_URL_UNPOOLED: url },
    stdio: "pipe",
  });
  writeFileSync(resolve(".env.migration"), `# REHEARSAL target, drop when done\nDATABASE_URL=${url}\nDATABASE_URL_UNPOOLED=${url}\nPOSTGRES_URL_NON_POOLING=${url}\n`, { mode: 0o600 });
  console.log(`rehearsal database: ${db}`);
})();
