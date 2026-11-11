import { createRepository } from "./server";
import { PgAnalyticsRepository } from "./db/postgres";

async function main(): Promise<void> {
  const repository = createRepository();
  if (!(repository instanceof PgAnalyticsRepository)) {
    throw new Error("No PostgreSQL connection: set DATABASE_URL");
  }
  try {
    await repository.migrate();
    console.log("[migrate] schema is up to date");
  } finally {
    await repository.close();
  }
}

main().catch((error) => {
  console.error("[migrate] failed:", error);
  process.exit(1);
});
