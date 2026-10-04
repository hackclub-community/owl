import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  AUTHOR_HASH_VERSION,
  authorCredential,
  hashAuthor,
  hashReplyKey,
  legacyAuthorHash,
  legacyReplyKeyHash,
  matchesHash,
  newReplyKey,
  ownsPost,
  pepperHash,
  REPLY_KEY_HASH_VERSION,
  REPLY_KEY_SALT,
  replyKeyCredential,
} from "./security.js";

const user = "U123";
const otherUser = "U456";
const key = "reply-secret";
const pepper = "p".repeat(32);
const otherPepper = "q".repeat(32);
const owns = (post: Parameters<typeof ownsPost>[0], userId: string, replyKey: string) =>
  ownsPost(post, userId, replyKey, pepper);
const legacyPost = () => ({
  authorSalt: null,
  authorHash: null,
  authorHashVersion: 1,
  replyKeyHash: legacyReplyKeyHash(key, user),
  replyKeyHashVersion: 1,
});
const keyPost = async (userId: string) => ({
  authorSalt: null,
  authorHash: null,
  authorHashVersion: 1,
  ...(await replyKeyCredential(key, userId, pepper)),
});
const accountPost = async (userId: string) => ({
  ...(await authorCredential(userId, pepper)),
  replyKeyHash: null,
  replyKeyHashVersion: 1,
});

describe("ownership", () => {
  test("account credentials authorize the author without a reply key", async () => {
    const post = await accountPost(user);
    expect(await owns(post, user, "")).toBe(true);
    expect(await owns(post, user, "unrelated-key")).toBe(true);
    expect(await owns(post, otherUser, "")).toBe(false);
  });

  test("account credentials take precedence over a matching legacy key", async () => {
    const post = { ...(await accountPost(user)), replyKeyHash: legacyReplyKeyHash(key, otherUser) };
    expect(await owns(post, otherUser, key)).toBe(false);
    expect(await owns(post, user, key)).toBe(true);
  });

  test("peppered account hashes need the same pepper", async () => {
    const post = await accountPost(user);
    expect(await ownsPost(post, user, "", otherPepper)).toBe(false);
  });

  test("v1 account hashes still verify until migrate upgrades them", async () => {
    const post = {
      authorSalt: "salt",
      authorHash: legacyAuthorHash(user, "salt"),
      authorHashVersion: 1,
      replyKeyHash: null,
      replyKeyHashVersion: 1,
    };
    expect(await owns(post, user, "")).toBe(true);
    expect(await owns(post, otherUser, "")).toBe(false);
    // block fat fingers!
    expect(await owns({ ...post, authorHashVersion: AUTHOR_HASH_VERSION }, user, "")).toBe(false);
  });

  test("legacy ownership requires both the correct key and account", async () => {
    expect(await owns(legacyPost(), user, key)).toBe(true);
    expect(await owns(legacyPost(), user, "wrong-key")).toBe(false);
    expect(await owns(legacyPost(), otherUser, key)).toBe(false);
    expect(await owns(legacyPost(), user, "")).toBe(false);
    expect(await owns({ ...legacyPost(), replyKeyHash: null }, user, key)).toBe(false);
    expect(
      await owns(
        {
          authorSalt: null,
          authorHash: null,
          authorHashVersion: 1,
          replyKeyHash: null,
          replyKeyHashVersion: 1,
        },
        user,
        key,
      ),
    ).toBe(false);
  });

  test("incomplete account credentials fall back to legacy ownership", async () => {
    expect(await owns({ ...legacyPost(), authorSalt: "salt" }, user, key)).toBe(true);
    expect(
      await owns(
        { ...legacyPost(), authorHash: await hashAuthor(user, "salt", pepper) },
        user,
        key,
      ),
    ).toBe(true);
  });

  test("peppered reply keys need the key, the account, and the same pepper", async () => {
    const post = await keyPost(user);
    expect(await owns(post, user, key)).toBe(true);
    expect(await owns(post, user, "wrong-key")).toBe(false);
    expect(await owns(post, user, "")).toBe(false);
    expect(await owns(post, otherUser, key)).toBe(false);
    expect(await ownsPost(post, user, key, otherPepper)).toBe(false);
  });

  // we dont need another fat finger test, we should be fine trust

  test.each(["", "not-hex", "ab", "a".repeat(63), "a".repeat(66), "gg".repeat(32)])(
    "malformed stored hash %j denies ownership without throwing",
    async (hash) => {
      for (const replyKeyHashVersion of [1, REPLY_KEY_HASH_VERSION]) {
        expect(
          await owns({ ...legacyPost(), replyKeyHash: hash, replyKeyHashVersion }, user, key),
        ).toBe(false);
      }
      for (const authorHashVersion of [1, AUTHOR_HASH_VERSION]) {
        expect(
          await owns(
            {
              authorSalt: "salt",
              authorHash: hash,
              authorHashVersion,
              replyKeyHash: null,
              replyKeyHashVersion: 1,
            },
            user,
            key,
          ),
        ).toBe(false);
      }
    },
  );
});

describe("hashes and credentials", () => {
  test("hashes use the expected SHA-256 inputs and are account/salt specific", async () => {
    const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
    expect(legacyReplyKeyHash(key, user)).toBe(sha256(`${key}:${user}`));
    expect(legacyAuthorHash(user, "salt")).toBe(sha256(`salt:${user}`));
    expect(legacyReplyKeyHash(key, user)).not.toBe(legacyReplyKeyHash(key, otherUser));
    expect(legacyReplyKeyHash(key, user)).not.toBe(legacyReplyKeyHash("other-key", user));
    const reply = await hashReplyKey(key, user, pepper);
    expect(reply).not.toBe(legacyReplyKeyHash(key, user));
    expect(reply).not.toBe(await hashReplyKey(key, otherUser, pepper));
    expect(reply).not.toBe(await hashReplyKey("other-key", user, pepper));
    expect(reply).not.toBe(await hashReplyKey(key, user, otherPepper));
    const author = await hashAuthor(user, "salt", pepper);
    expect(author).not.toBe(legacyAuthorHash(user, "salt"));
    expect(author).not.toBe(await hashAuthor(otherUser, "salt", pepper));
    expect(author).not.toBe(await hashAuthor(user, "other-salt", pepper));
    expect(author).not.toBe(await hashAuthor(user, "salt", otherPepper));
  });

  test("upgrading a stored v1 hash matches hashing from scratch", async () => {
    const legacy = legacyAuthorHash(user, "salt");
    expect(await pepperHash(legacy, "salt", pepper)).toBe(await hashAuthor(user, "salt", pepper));
    expect(await pepperHash(legacyReplyKeyHash(key, user), REPLY_KEY_SALT, pepper)).toBe(
      await hashReplyKey(key, user, pepper),
    );
  });

  test("reply key credentials are tagged with the current version", async () => {
    const credential = await replyKeyCredential(key, user, pepper);
    expect(credential.replyKeyHashVersion).toBe(REPLY_KEY_HASH_VERSION);
    expect(credential.replyKeyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("new keys and author salts are independent 32-byte hex secrets", async () => {
    const firstKey = newReplyKey();
    const secondKey = newReplyKey();
    const first = await authorCredential(user, pepper);
    const second = await authorCredential(user, pepper);
    for (const value of [
      firstKey,
      secondKey,
      first.authorSalt,
      second.authorSalt,
      first.authorHash,
    ]) {
      expect(value).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(firstKey).not.toBe(secondKey);
    expect(first.authorSalt).not.toBe(second.authorSalt);
    expect(first.authorHash).not.toBe(second.authorHash);
    expect(first.authorHashVersion).toBe(AUTHOR_HASH_VERSION);
    expect(first.authorHash).toBe(await hashAuthor(user, first.authorSalt, pepper));
    expect(second.authorHash).toBe(await hashAuthor(user, second.authorSalt, pepper));
  });

  test("hash comparison accepts matching digest bytes and rejects mismatches", () => {
    const hash = legacyReplyKeyHash(key, user);
    expect(matchesHash(hash, hash)).toBe(true);
    expect(matchesHash(hash, hash.toUpperCase())).toBe(true);
    expect(matchesHash(hash, legacyReplyKeyHash(key, otherUser))).toBe(false);
  });

  test.each(["", "xyz", "ab", "a".repeat(63), "a".repeat(66), "gg".repeat(32)])(
    "hash comparison rejects malformed digest %j on either side",
    (malformed) => {
      const hash = legacyReplyKeyHash(key, user);
      expect(matchesHash(malformed, hash)).toBe(false);
      expect(matchesHash(hash, malformed)).toBe(false);
      expect(matchesHash(malformed, malformed)).toBe(false);
    },
  );
});
