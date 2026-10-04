import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq, isNotNull } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { readPepper } from "../config.js";
import { AUTHOR_HASH_VERSION, pepperAuthorHash } from "../slack/security.js";
import { createDatabase } from "./client.js";
import { confessions } from "./schema.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("no DATABASE_URL????");
const pepper = readPepper();
const { db, pool } = createDatabase(url, 1);
try {
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle/", import.meta.url)),
  });
  console.log("migrations locked and loaded!");
  const legacy = await db
    .select({
      id: confessions.id,
      authorSalt: confessions.authorSalt,
      authorHash: confessions.authorHash,
    })
    .from(confessions)
    .where(
      and(
        eq(confessions.authorHashVersion, 1),
        isNotNull(confessions.authorSalt),
        isNotNull(confessions.authorHash),
      ),
    );
  let upgraded = 0;
  for (const row of legacy) {
    const authorHash = await pepperAuthorHash(row.authorHash!, row.authorSalt!, pepper);
    // leave this, it doubles as the undo rev on review messages
    const done = await db
      .update(confessions)
      .set({ authorHash, authorHashVersion: AUTHOR_HASH_VERSION })
      .where(
        and(
          eq(confessions.id, row.id),
          eq(confessions.authorHashVersion, 1),
          eq(confessions.authorHash, row.authorHash!),
        ),
      )
      .returning({ id: confessions.id });
    upgraded += done.length;
  }
  if (upgraded) console.log(`peppered ${upgraded} old author hash(es)`);
} finally {
  await pool.end();
}
