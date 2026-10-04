import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { createDatabase } from "./client.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("no DATABASE_URL????");
const { db, pool } = createDatabase(url, 1);
try {
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle/", import.meta.url)),
  });
  console.log("migrations locked and loaded!");
} finally {
  await pool.end();
}
