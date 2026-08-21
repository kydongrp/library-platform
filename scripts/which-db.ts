// Prints the database a given env file resolves to. Guards against running a
// destructive suite against production by accident.
import { Client } from "pg";
import { connectionString, describeTarget } from "./lib/dump";
void (async () => {
  const url = connectionString();
  const c = new Client({ connectionString: url });
  await c.connect();
  const r = await c.query<{ d: string }>("SELECT current_database() AS d");
  const n = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM "Resource"`);
  console.log(`TARGET ${describeTarget(url)} | database=${r.rows[0].d} | resources=${n.rows[0].n}`);
  await c.end();
})();
