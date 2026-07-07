// Build-time seed entrypoint: seeds the database only if it's empty, so the
// first deploy populates demo data and subsequent deploys leave data intact.
import "dotenv/config";

process.env.SEED_IF_EMPTY = "1";

// Dynamic import so the flag is set before seed.ts runs its main().
await import("./seed");
