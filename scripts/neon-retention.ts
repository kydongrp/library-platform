/**
 * Read or set the Neon history window (point-in-time restore range).
 *
 *   NEON_API_KEY=... npx tsx --env-file=.env scripts/neon-retention.ts            # show current
 *   NEON_API_KEY=... npx tsx --env-file=.env scripts/neon-retention.ts 30d        # set to 30 days
 *
 * Why this exists: Neon's history window is the ONLY recovery mechanism on the
 * platform (there are no traditional backups), and it defaults short on every
 * plan: 1 day on Launch and Scale, 6 hours on Free. Upgrading the plan does
 * not widen the window; something has to set it.
 *
 * The project is identified by asking the running database for its own
 * `neon.project_id`, not by trusting a project name in a console tab. That
 * matters: a Scale upgrade was once applied to a Neon organisation that looked
 * right and turned out not to own this database at all. If the API key cannot
 * see the project the database reports, this script says so and changes
 * nothing, rather than reconfiguring a lookalike.
 */
import { neonIdentity } from "./lib/neon-identity";

const API = "https://console.neon.tech/api/v2";

const SPANS: Record<string, number> = {
  "0": 0,
  "6h": 6 * 3600,
  "1d": 86_400,
  "7d": 604_800,
  "14d": 1_209_600,
  "30d": 2_592_000,
};

/** Ceiling per Neon plan, for explaining a write that reads back lower. */
const PLAN_CEILING: Record<string, string> = {
  free: "6 hours",
  launch: "7 days",
  scale: "30 days",
  business: "30 days",
};

function describe(seconds: number): string {
  if (seconds === 0) return "disabled (no point-in-time restore)";
  if (seconds < 86_400) return `${seconds / 3600} hours`;
  return `${seconds / 86_400} days`;
}

type ApiResult<T> = { ok: true; body: T } | { ok: false; status: number; message: string };

async function api<T>(path: string, key: string, init?: RequestInit): Promise<ApiResult<T>> {
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
  // Never echo the key; the status and Neon's message are enough to act on.
  if (!res.ok) return { ok: false, status: res.status, message: text.slice(0, 300) };
  return { ok: true, body: (text ? JSON.parse(text) : {}) as T };
}

async function must<T>(path: string, key: string, init?: RequestInit): Promise<T> {
  const r = await api<T>(path, key, init);
  if (!r.ok) throw new Error(`Neon API ${r.status} on ${path}: ${r.message}`);
  return r.body;
}

type Project = {
  id: string;
  name: string;
  org_id?: string;
  region_id?: string;
  pg_version?: number;
  history_retention_seconds?: number;
  settings?: { history_retention_seconds?: number };
};
type Org = { id: string; name: string; plan?: string };

// Top-level is where the API actually reports it; the settings fallback is
// only there in case a future response moves it.
const retention = (p: Project): number =>
  p.history_retention_seconds ?? p.settings?.history_retention_seconds ?? 0;

void (async () => {
  const wanted = process.argv[2];
  if (wanted && !(wanted in SPANS)) {
    console.error(`Unknown span "${wanted}". Use one of: ${Object.keys(SPANS).join(", ")}`);
    process.exit(2);
  }

  // Identify the project BEFORE asking for a key: the first thing anyone needs
  // is the project id the key has to be able to reach. The database is the only
  // source that cannot be confused by a similarly-named project in another
  // organisation.
  const id = await neonIdentity();
  console.log(`Database : ${id.host}`);
  console.log(`Postgres : ${id.serverVersion}`);
  console.log(`Project  : ${id.projectId}   (reported by the database itself)`);
  console.log(`Branch   : ${id.branchId}`);
  console.log(`Endpoint : ${id.endpointId}`);
  console.log("");

  const key = process.env.NEON_API_KEY;
  if (!key) {
    console.error(`NEON_API_KEY is not set, so the window cannot be read or changed.`);
    console.error(`The key must belong to the Neon account that owns ${id.projectId}.`);
    console.error("Create one at Neon console > Account settings > API keys, then either");
    console.error("  add NEON_API_KEY=... to .env (git-ignored), or");
    console.error("  pass it for one command:  NEON_API_KEY=... npm run neon:retention -- 30d");
    console.error("The Vercel/Neon integration does not expose an API key.");
    process.exit(2);
  }

  const direct = await api<{ project: Project }>(`/projects/${id.projectId}`, key);
  if (!direct.ok) {
    console.error(`This API key cannot see project ${id.projectId} (HTTP ${direct.status}).`);
    // Show what it CAN see, so the mismatch is obvious rather than mysterious.
    const orgs = await api<{ organizations: Org[] }>("/users/me/organizations", key);
    if (orgs.ok) {
      for (const org of orgs.body.organizations ?? []) {
        const list = await api<{ projects: Project[] }>(
          `/projects?org_id=${encodeURIComponent(org.id)}&limit=100`,
          key,
        );
        const names = list.ok
          ? (list.body.projects ?? []).map((p) => `${p.name} (${p.id})`).join(", ") || "none"
          : `unreadable (HTTP ${list.status})`;
        console.error(`  org ${org.name} [${org.id}] plan=${org.plan ?? "?"} -> ${names}`);
      }
    }
    console.error("");
    console.error("Nothing was changed. Either use a key from the account that owns");
    console.error(`${id.projectId}, or move this database into an account you control.`);
    process.exit(1);
  }

  const project = direct.body.project;
  const current = retention(project);
  const org = project.org_id
    ? await api<{ organization: Org }>(`/organizations/${project.org_id}`, key)
    : null;
  const plan = org?.ok ? org.body.organization.plan : undefined;

  console.log(`Name     : ${project.name}`);
  console.log(`Region   : ${project.region_id ?? "unknown"}`);
  console.log(`Org      : ${project.org_id ?? "unknown"}${plan ? ` (plan: ${plan})` : ""}`);
  console.log(`Current  : ${current}s (${describe(current)})`);
  if (plan && PLAN_CEILING[plan]) console.log(`Ceiling  : ${PLAN_CEILING[plan]} on the ${plan} plan`);

  if (!wanted) {
    console.log("\nPass a span to change it, e.g. `30d`. Nothing was modified.");
    return;
  }

  const target = SPANS[wanted];
  if (target === current) {
    console.log(`\nAlready ${describe(current)}. Nothing to do.`);
    return;
  }

  console.log(`Setting  : ${target}s (${describe(target)})`);
  // history_retention_seconds is a top-level member of `project`. Nesting it
  // under `project.settings` (where most other project options live) is
  // accepted and does nothing.
  await must(`/projects/${id.projectId}`, key, {
    method: "PATCH",
    body: JSON.stringify({ project: { history_retention_seconds: target } }),
  });

  // Read it back rather than trusting the write.
  const after = await must<{ project: Project }>(`/projects/${id.projectId}`, key);
  const now = retention(after.project);
  if (now === target) {
    console.log(`OK       : confirmed ${now}s (${describe(now)})`);
  } else {
    console.error(`FAILED   : reads back as ${now}s (${describe(now)}), not ${describe(target)}`);
    console.error(
      plan && PLAN_CEILING[plan]
        ? `The ${plan} plan caps the window at ${PLAN_CEILING[plan]}.`
        : "A plan ceiling may be capping it (Free 6h, Launch 7d, Scale 30d).",
    );
    process.exit(1);
  }
})();
