import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// v1: sha256(salt:userId) and sha256(key:userId)
// v2 = scrypt over the v1 hash keyed with peppa!
export const AUTHOR_HASH_VERSION = 2;
export const REPLY_KEY_HASH_VERSION = 2;
export const REPLY_KEY_SALT = "owl:reply-key";
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export const newReplyKey = () => randomBytes(32).toString("hex");

export function pepperHash(digest: string, salt: string, pepper: string) {
  const keyed = createHmac("sha256", pepper).update(digest).digest();
  return new Promise<string>((resolve, reject) =>
    scrypt(keyed, salt, 32, SCRYPT, (error, hash) =>
      error ? reject(error) : resolve(hash.toString("hex")),
    ),
  );
}

export function hashAuthor(userId: string, salt: string, pepper: string) {
  return pepperHash(sha256(`${salt}:${userId}`), salt, pepper);
}

export function hashReplyKey(key: string, userId: string, pepper: string) {
  return pepperHash(sha256(`${key}:${userId}`), REPLY_KEY_SALT, pepper);
}

export async function replyKeyCredential(key: string, userId: string, pepper: string) {
  return {
    replyKeyHash: await hashReplyKey(key, userId, pepper),
    replyKeyHashVersion: REPLY_KEY_HASH_VERSION,
  };
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
    replyKeyHashVersion: number;
  },
  userId: string,
  key: string,
  pepper: string,
) {
  // we killed the unsecure v1 stuff so we only accept v2. good for security!
  if (post.authorSalt && post.authorHash) {
    return (
      post.authorHashVersion === AUTHOR_HASH_VERSION &&
      matchesHash(await hashAuthor(userId, post.authorSalt, pepper), post.authorHash)
    );
  }
  if (!key || !post.replyKeyHash || post.replyKeyHashVersion !== REPLY_KEY_HASH_VERSION) {
    return false;
  }
  return matchesHash(await hashReplyKey(key, userId, pepper), post.replyKeyHash);
}
