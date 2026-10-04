import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq, isNotNull, or, type SQL } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { readPepper } from "../config.js";
import {
  AUTHOR_HASH_VERSION,
  pepperHash,
  REPLY_KEY_HASH_VERSION,
  REPLY_KEY_SALT,
} from "../slack/security.js";
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

  const legacyAuthor = and(
    eq(confessions.authorHashVersion, 1),
    isNotNull(confessions.authorSalt),
    isNotNull(confessions.authorHash),
  );

  const legacyReplyKey = and(
    eq(confessions.replyKeyHashVersion, 1),
    isNotNull(confessions.replyKeyHash),
  );
  const legacy = await db
    .select({
      id: confessions.id,
      authorSalt: confessions.authorSalt,
      authorHash: confessions.authorHash,
      authorHashVersion: confessions.authorHashVersion,
      replyKeyHash: confessions.replyKeyHash,
      replyKeyHashVersion: confessions.replyKeyHashVersion,
    })
    .from(confessions)
    .where(or(legacyAuthor, legacyReplyKey));
  let authors = 0;
  let replyKeys = 0;

  for (const row of legacy) {
    const set: Partial<typeof confessions.$inferInsert> = {};
    const unchanged: SQL[] = [eq(confessions.id, row.id)];
    if (row.authorHashVersion === 1 && row.authorSalt && row.authorHash) {
      set.authorHash = await pepperHash(row.authorHash, row.authorSalt, pepper);
      set.authorHashVersion = AUTHOR_HASH_VERSION;
      unchanged.push(
        eq(confessions.authorHashVersion, 1),
        eq(confessions.authorHash, row.authorHash),
      );
    }

    if (row.replyKeyHashVersion === 1 && row.replyKeyHash) {
      set.replyKeyHash = await pepperHash(row.replyKeyHash, REPLY_KEY_SALT, pepper);
      set.replyKeyHashVersion = REPLY_KEY_HASH_VERSION;
      unchanged.push(
        eq(confessions.replyKeyHashVersion, 1),
        eq(confessions.replyKeyHash, row.replyKeyHash),
      );
    }

    // leave this, it doubles as the undo rev on review messages
    const done = await db
      .update(confessions)
      .set(set)
      .where(and(...unchanged))
      .returning({ id: confessions.id });
    if (!done.length) continue;
    if (set.authorHash) authors++;
    if (set.replyKeyHash) replyKeys++;
  }
  if (authors) console.log(`peppered ${authors} old author hash(es)`);
  if (replyKeys) console.log(`peppered ${replyKeys} old reply key hash(es)`);
} finally {
  await pool.end();
}
