import "../src/lib/load-env";
import { migrate } from "../src/db/migrate";
import { DB_PATH } from "../src/lib/env";

migrate();
console.log(`✓ Migrated database at ${DB_PATH}`);
