/**
 * Read or set the Neon history window (point-in-time restore range).
 *
 *   NEON_API_KEY=... npx tsx --env-file=.env scripts/neon-retention.ts            # show current
 *   NEON_API_KEY=... npx tsx --env-file=.env scripts/neon-retention.ts 30d        # set to 30 days
 *
 * Why this exists: Neon's history window is the ONLY recovery mechanism on the
 * platform (there are no traditional backups), and it defaults to 1 day on
 * every plan — including Scale, where 30 days is available. Upgrading the plan
 * does not widen the window; something has to set it.
 *
 * The project is identified by matching the compute endpoint in DATABASE_URL,
 * so this cannot silently reconfigure the wrong project.
 */
import { connectionString } from "./lib/dump";

const API = "https://console.neon.tech/api/v2";

const SPANS: Record<string, number> = {
  "0": 0,
  "6h": 6 * 3600,
  "1d": 86_400,
  "7d": 604_800,
  "14d": 1_209_600,
  "30d": 2_592_000,
};

function describe(seconds: number): string {
  if (seconds === 0) return "disabled (no point-in-time restore)";
  if (seconds < 86_400) return `${seconds / 3600} hours`;
  return `${seconds / 86_400} days`;
}

async function api<T>(path: string, key: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) {
    // Never echo the key; the status and Neon's message are enough to act on.
    throw new Error(`Neon API ${res.status} on ${path}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as T;
}

type Project = { id: string; name: string; region_id?: string; settings?: { history_retention_seconds?: number } };
type Endpoint = { id: string; host: string; project_id: string };

void (async () => {
  const key = process.env.NEON_API_KEY;
  if (!key) {
    console.error("NEON_API_KEY is not set.");
    console.error("Create one at Neon console > Account settings > API keys, then either");
    console.error("  add NEON_API_KEY=... to .env (git-ignored), or");
    console.error("  pass it for one command:  NEON_API_KEY=... npm run neon:retention -- 30d");
    console.error("The Vercel/Neon integration does not expose an API key.");
    process.exit(2);
  }

  const wanted = process.argv[2];
  if (wanted && !(wanted in SPANS)) {
    console.error(`Unknown span "${wanted}". Use one of: ${Object.keys(SPANS).join(", ")}`);
    process.exit(2);
  }

  // Identify OUR project by the endpoint host in the connection string, so a
  // multi-project account cannot get the wrong one reconfigured.
  const host = new URL(connectionString()).hostname;
  const endpointId = host.split(".")[0].replace(/-pooler$/, "");
  console.log(`Looking for the project owning endpoint ${endpointId}`);

  const { projects } = await api<{ projects: Project[] }>("/projects", key);
  let match: { project: Project; endpoint: Endpoint } | null = null;
  for (const p of projects) {
    const { endpoints } = await api<{ endpoints: Endpoint[] }>(`/projects/${p.id}/endpoints`, key);
    const ep = endpoints.find((e) => e.id === endpointId || e.host.startsWith(endpointId));
    if (ep) {
      match = { project: p, endpoint: ep };
      break;
    }
  }
  if (!match) {
    console.error(`No project in this account owns ${endpointId}.`);
    console.error(`Projects visible to this key: ${projects.map((p) => `${p.name} (${p.id})`).join(", ") || "none"}`);
    process.exit(1);
  }

  const { project } = match;
  // Re-read the project directly; the list response may omit settings.
  const full = await api<{ project: Project }>(`/projects/${project.id}`, key);
  const current = full.project.settings?.history_retention_seconds ?? 0;
  console.log(`Project : ${full.project.name} (${project.id})`);
  console.log(`Region  : ${full.project.region_id ?? "unknown"}`);
  console.log(`Current : ${current}s — ${describe(current)}`);

  if (!wanted) {
    console.log("\nPass a span to change it, e.g. `30d`. Nothing was modified.");
    return;
  }

  const target = SPANS[wanted];
  if (target === current) {
    console.log(`\nAlready ${describe(current)}. Nothing to do.`);
    return;
  }

  console.log(`Setting : ${target}s — ${describe(target)}`);
  await api(`/projects/${project.id}`, key, {
    method: "PATCH",
    body: JSON.stringify({ project: { settings: { history_retention_seconds: target } } }),
  });

  // Read it back rather than trusting the write.
  const after = await api<{ project: Project }>(`/projects/${project.id}`, key);
  const now = after.project.settings?.history_retention_seconds ?? 0;
  if (now === target) {
    console.log(`OK      : confirmed ${now}s — ${describe(now)}`);
  } else {
    console.error(`FAILED  : reads back as ${now}s — ${describe(now)}, not ${describe(target)}`);
    console.error("A plan ceiling may be capping it (Free 6h, Launch 7d, Scale 30d).");
    process.exit(1);
  }
})();
