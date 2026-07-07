// Build-time seed entrypoint: seeds the database only if it's empty, so the
// first deploy populates demo data and subsequent deploys leave data intact.
import "dotenv/config";

process.env.SEED_IF_EMPTY = "1";

// Dynamic import so the flag is set before seed.ts runs its main().
// Not awaited at top level (tsx compiles to CJS, which forbids top-level await);
// seed.ts drives its own async main() and keeps the process alive until done.
void import("./seed");
