import { describe, expect, mock, test } from "bun:test";
import type { App } from "@slack/bolt";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { dmPrompt, registerDmHandlers } from "./dm.js";
import { hashReplyKey, ownsPost } from "./security.js";
import { MAX_TEXT } from "./content.js";

const config: Config = {
  databaseUrl: "unused",
  token: "unused",
  signingSecret: "test-signing-secret",
  pepper: "testy-test-pepper-pls-be-long-enough",
  channels: { post: "CPOST", meta: "CMETA", review: "CREVIEW", log: "CLOG" },
  port: 8080,
  poolSize: 1,
};
type Handler = (args: Record<string, unknown>) => Promise<void>;
type Submission = {
  submissionId: string;
  text: string;
  content: unknown;
  postChannel: string;
  authorSalt?: string;
  authorHash?: string;
  authorHashVersion?: number;
  replyKeyHash?: string;
};

function harness(initialText = "A confession") {
  const events = new Map<string, Handler>();
  const actions = new Map<string, Handler>();
  const app = {
    event: (name: string, handler: Handler) => events.set(name, handler),
    action: (name: string, handler: Handler) => actions.set(name, handler),
  };
  let post:
    | (Omit<Submission, "authorSalt" | "authorHash" | "authorHashVersion" | "replyKeyHash"> & {
        id: number;
        status: string;
        reviewTs: string | null;
        authorSalt: string | null;
        authorHash: string | null;
        authorHashVersion: number;
        replyKeyHash: string | null;
      })
    | undefined;
  const insert = mock((_table: unknown) => ({
    values: (values: Submission) => ({
      onConflictDoNothing: (_options: unknown) => ({
        returning: async () => {
          if (post) return [];
          post = {
            authorSalt: null,
            authorHash: null,
            authorHashVersion: 1,
            replyKeyHash: null,
            ...values,
            id: 67,
            status: "pending",
            reviewTs: null,
          };
          return [post];
        },
      }),
    }),
  }));
  const findFirst = mock(async (_options: unknown) => post);
  const tx = {
    select: () => ({
      from: (_table: unknown) => ({
        where: (_condition: unknown) => ({
          for: async (_lock: string) => (post && !post.reviewTs ? [post] : []),
        }),
      }),
    }),
    update: (_table: unknown) => ({
      set: (values: { reviewTs: string }) => ({
        where: async (_condition: unknown) => {
          if (post) post.reviewTs = values.reviewTs;
        },
      }),
    }),
  };
  const transaction = mock(async (callback: (value: typeof tx) => Promise<void>) => callback(tx));
  const db = { insert, query: { confessions: { findFirst } }, transaction };
  const postMessage = mock(async (_args: Record<string, unknown>) => ({
    ok: true,
    ts: "200.000001",
  }));
  const update = mock(async (_args: Record<string, unknown>) => ({ ok: true }));
  const client = { chat: { postMessage, update } };
  const ack = mock(async () => {});
  registerDmHandlers(app as unknown as App, db as unknown as Database, config);
  const prompt = dmPrompt(initialText, "UAUTHOR", "DAUTHOR", "100.000001", config.signingSecret);
  const buttonBlock = prompt[3];
  if (buttonBlock?.type !== "actions") throw new Error("Missing submit actions");
  const button = buttonBlock.elements[0];
  if (button?.type !== "button") throw new Error("Missing submit button");
  const body = {
    user: { id: "UAUTHOR" },
    channel: { id: "DAUTHOR" },
    message: { ts: "100.000002", thread_ts: "100.000001", blocks: prompt },
    state: {
      values: { dm_ownership: { dm_passphrase: { selected_options: [] as { value: string }[] } } },
    },
  };
  const action = { value: button.value };
  return {
    body,
    action,
    ack,
    client,
    insert,
    findFirst,
    transaction,
    getPost: () => post,
    message: (event: Record<string, unknown>) => events.get("message")!({ event, client }),
    submit: () => actions.get("dm_submit")!({ ack, body, action, client }),
  };
}

const message = {
  channel_type: "im",
  channel: "DAUTHOR",
  user: "UAUTHOR",
  ts: "100.000001",
  text: "hello",
};

describe("DM messages", () => {
  test("accepts the shared maximum and rejects one character over it", async () => {
    const h = harness();
    await h.message({ ...message, text: "a".repeat(MAX_TEXT) });
    expect(h.client.chat.postMessage.mock.calls[0]?.[0].blocks).toBeDefined();
    await h.message({ ...message, text: "a".repeat(MAX_TEXT + 1) });
    expect(h.client.chat.postMessage.mock.calls[1]?.[0].text).toContain(String(MAX_TEXT));
    expect(h.client.chat.postMessage.mock.calls[1]?.[0].blocks).toBeUndefined();
  });
  test.each([
    { ...message, channel_type: "channel" },
    { ...message, subtype: "message_changed" },
    { ...message, bot_id: "BBOT" },
    { ...message, user: "" },
  ])("ignores non-human or non-DM messages: %j", async (event) => {
    const h = harness();
    await h.message(event);
    expect(h.client.chat.postMessage).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });

  test("prompts in the existing thread without saving yet", async () => {
    const h = harness();
    await h.message({ ...message, thread_ts: "90.000001" });
    expect(h.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "DAUTHOR",
        thread_ts: "90.000001",
        unfurl_links: false,
        unfurl_media: false,
      }),
    );
    expect(h.insert).not.toHaveBeenCalled();
  });

  test.each([
    { ...message, text: "   " },
    { ...message, blocks: [{ type: "unsupported" }] },
  ])("rejects invalid content without a submit prompt", async (event) => {
    const h = harness();
    await h.message(event);
    expect(h.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Malformed or unsupported"),
      }),
    );
    expect(h.insert).not.toHaveBeenCalled();
  });
});

describe("DM confirmation", () => {
  test("a maximum-length DM survives signature verification, storage, and review delivery", async () => {
    const body = "a".repeat(MAX_TEXT);
    const h = harness(body);
    await h.submit();
    expect(h.getPost()?.text).toBe(body);
    expect(h.getPost()?.reviewTs).toBe("200.000001");
    const blocks = h.client.chat.postMessage.mock.calls[0]?.[0].blocks;
    expect(Array.isArray(blocks) && blocks.length > 2).toBe(true);
  });
  test("saves salted ownership, confirms, and delivers to review", async () => {
    const h = harness();
    await h.submit();
    expect(h.ack).toHaveBeenCalledTimes(1);
    expect(h.insert).toHaveBeenCalledTimes(1);
    const post = h.getPost()!;
    expect(post.text).toBe("A confession");
    expect(post.postChannel).toBe("CPOST");
    expect(post.replyKeyHash).toBeNull();
    expect(await ownsPost(post, "UAUTHOR", "", config.pepper)).toBe(true);
    expect(JSON.stringify(post)).not.toContain("UAUTHOR");
    expect(h.client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "DAUTHOR",
        text: "Confession #67 submitted and awaiting review.",
      }),
    );
    expect(h.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "CREVIEW",
        text: "Anonymous post #67",
        unfurl_links: false,
        unfurl_media: false,
      }),
    );
    expect(post.reviewTs).toBe("200.000001");
  });

  test("passphrase mode saves only a hash and reveals the key privately", async () => {
    const h = harness();
    h.body.state.values.dm_ownership.dm_passphrase.selected_options = [{ value: "passphrase" }];
    await h.submit();
    const post = h.getPost()!;
    expect(post.authorSalt).toBeNull();
    expect(post.authorHash).toBeNull();
    const confirmation = JSON.stringify(h.client.chat.update.mock.calls[0]![0]);
    const key = confirmation.match(/Your private reply key:\\n([a-f0-9]{64})/)?.[1];
    expect(key).toBeDefined();
    expect(post.replyKeyHash).toBe(hashReplyKey(key!, "UAUTHOR"));
    expect(JSON.stringify(h.client.chat.postMessage.mock.calls)).not.toContain(key!);
  });

  test.each(["user", "channel", "signature", "preview", "version", "json"] as const)(
    "rejects tampered %s before touching the database",
    async (field) => {
      const h = harness();
      const context = JSON.parse(h.action.value!) as Record<string, unknown>;
      if (field === "preview")
        h.body.message.blocks[1] = dmPrompt(
          "changed",
          "UAUTHOR",
          "DAUTHOR",
          "100.000001",
          config.signingSecret,
        )[1]!;
      else if (field === "json") h.action.value = "not json";
      else {
        context[field] = field === "version" ? 99 : "tampered";
        h.action.value = JSON.stringify(context);
      }
      await h.submit();
      expect(h.ack).toHaveBeenCalledTimes(1);
      expect(h.insert).not.toHaveBeenCalled();
      expect(h.transaction).not.toHaveBeenCalled();
      expect(h.client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "DAUTHOR",
          thread_ts: "100.000001",
          text: expect.stringContaining("This confirmation is invalid"),
        }),
      );
    },
  );

  test("duplicate clicks reuse the saved post and do not redeliver review", async () => {
    const h = harness();
    await h.submit();
    await h.submit();
    expect(h.findFirst).toHaveBeenCalledTimes(1);
    expect(h.client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(h.client.chat.update).toHaveBeenCalledTimes(2);
  });

  test("reports database failure without confirming or delivering review", async () => {
    const h = harness();
    h.insert.mockImplementationOnce(() => {
      throw new Error("Database unavailable");
    });
    await h.submit();
    expect(h.client.chat.update).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Could not submit this confession. Please try again, or use `/owl`.",
      }),
    );
  });

  test("keeps saved submissions recoverable when review delivery fails", async () => {
    const h = harness();
    h.client.chat.postMessage.mockRejectedValueOnce(new Error("Slack unavailable"));
    await h.submit();
    expect(h.getPost()?.reviewTs).toBeNull();
    expect(h.client.chat.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: "Confession #67 is saved, but review delivery is delayed. Moderators can recover it with /owl-revive.",
      }),
    );
    await h.submit();
    expect(h.getPost()?.reviewTs).toBe("200.000001");
    expect(h.findFirst).toHaveBeenCalledTimes(1);
  });
});
