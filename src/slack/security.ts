import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// v1: sha256(salt:userId)
// v2 = scrypt over the v1 hash keyed with peppa!
export const AUTHOR_HASH_VERSION = 2;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const newReplyKey = () => randomBytes(32).toString("hex");
export const hashReplyKey = (key: string, userId: string) =>
  createHash("sha256").update(`${key}:${userId}`).digest("hex");

export function legacyAuthorHash(userId: string, salt: string) {
  return createHash("sha256").update(`${salt}:${userId}`).digest("hex");
}

export function pepperAuthorHash(legacyHash: string, salt: string, pepper: string) {
  const keyed = createHmac("sha256", pepper).update(legacyHash).digest();
  return new Promise<string>((resolve, reject) =>
    scrypt(keyed, salt, 32, SCRYPT, (error, hash) =>
      error ? reject(error) : resolve(hash.toString("hex")),
    ),
  );
}

export function hashAuthor(userId: string, salt: string, pepper: string) {
  return pepperAuthorHash(legacyAuthorHash(userId, salt), salt, pepper);
}

export async function authorCredential(userId: string, pepper: string) {
  const authorSalt = randomBytes(32).toString("hex");
  return {
    authorSalt,
    authorHash: await hashAuthor(userId, authorSalt, pepper),
    authorHashVersion: AUTHOR_HASH_VERSION,
  };
}

export function matchesHash(actual: string, expected: string) {
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
}
export async function ownsPost(
  post: {
    authorSalt: string | null;
    authorHash: string | null;
    authorHashVersion: number;
    replyKeyHash: string | null;
  },
  userId: string,
  key: string,
  pepper: string,
) {
  if (post.authorSalt && post.authorHash) {
    const hash =
      post.authorHashVersion === AUTHOR_HASH_VERSION
        ? await hashAuthor(userId, post.authorSalt, pepper)
        : legacyAuthorHash(userId, post.authorSalt);
    return matchesHash(hash, post.authorHash);
  }
  return !!key && !!post.replyKeyHash && matchesHash(hashReplyKey(key, userId), post.replyKeyHash);
}
