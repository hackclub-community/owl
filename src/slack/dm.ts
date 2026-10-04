import { createHmac } from "node:crypto";
import type { App, BlockAction, ButtonAction } from "@slack/bolt";
import type { KnownBlock } from "@slack/web-api";
import { and, eq, isNull } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { confessions } from "../db/schema.js";
import { authorCredential, hashReplyKey, matchesHash, ownsPost } from "./security.js";
import { contentFromBlocks, contentFromText, MAX_TEXT, type Content } from "./content.js";
import { reviewBlocks } from "./views.js";

const plain = (text: string) => ({ type: "plain_text" as const, text });
const digest = (secret: string, purpose: string, parts: string[]) =>
  createHmac("sha256", secret)
    .update(JSON.stringify([purpose, ...parts]))
    .digest("hex");

export function dmPrompt(
  value: Content | string,
  user: string,
  channel: string,
  ts: string,
  secret: string,
): KnownBlock[] {
  const content =
    typeof value === "string" ? contentFromText(value) : contentFromBlocks(value.block);
  const signature = digest(secret, "dm-submission", [
    user,
    channel,
    ts,
    JSON.stringify(content.block),
  ]);
  return [
    { type: "section", text: plain("Do you want to submit this confession for review?") },
    content.block,
    {
      type: "actions",
      block_id: "dm_ownership",
      elements: [
        {
          type: "checkboxes",
          action_id: "dm_passphrase",
          options: [
            {
              text: plain("Use a private reply key (passphrase option)"),
              value: "passphrase",
              description: plain(
                "Requires this account and a generated secret you save. Leave unchecked for an account hash.",
              ),
            },
          ],
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "dm_submit",
          style: "primary",
          text: plain("Yes, submit"),
          value: JSON.stringify({ version: 2, user, channel, ts, signature }),
        },
      ],
    },
  ];
}

export function registerDmHandlers(app: App, db: Database, config: Config) {
  app.event("message", async ({ event, client }) => {
    if (
      event.channel_type !== "im" ||
      event.subtype ||
      !("user" in event) ||
      !event.user ||
      "bot_id" in event
    )
      return;
    const text = ("text" in event ? event.text : "")?.trim() ?? "";
    const thread_ts = ("thread_ts" in event ? event.thread_ts : undefined) ?? event.ts;
    let content: Content;
    try {
      content =
        "blocks" in event && event.blocks !== undefined
          ? contentFromBlocks(event.blocks)
          : contentFromText(text);
    } catch {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts,
        text: `Send a confession between 1 and ${MAX_TEXT} visible characters using supported Slack text formatting (at most 48KB). Malformed or unsupported blocks and attachments are not submitted.`,
      });
      return;
    }
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts,
      text: "Do you want to submit this confession for review?",
      blocks: dmPrompt(content, event.user, event.channel, event.ts, config.signingSecret),
      unfurl_links: false,
      unfurl_media: false,
    });
  });
  app.action("dm_passphrase", async ({ ack }) => {
    await ack();
  });
  app.action<BlockAction<ButtonAction>>("dm_submit", async ({ ack, body, action, client }) => {
    await ack();
    if (!body.channel?.id.startsWith("D") || !body.message?.ts) return;
    const reply = (text: string) =>
      client.chat.postMessage({
        channel: body.channel!.id,
        thread_ts: body.message!.thread_ts ?? body.message!.ts,
        text,
      });
    const preview = body.message.blocks?.[1];
    let context: { version?: number; user: string; channel: string; ts: string; signature: string };
    let content: Content;
    try {
      context = JSON.parse(action.value ?? "");
      if (
        !context ||
        ![context.user, context.channel, context.ts, context.signature].every(
          (value) => typeof value === "string",
        ) ||
        context.user !== body.user.id ||
        context.channel !== body.channel.id ||
        !context.channel.startsWith("D")
      )
        throw new Error("Invalid prompt");
      let signedContent: string;
      let sanitized: Content | undefined;
      if (context.version === 2) {
        sanitized = contentFromBlocks(preview);
        signedContent = JSON.stringify(sanitized.block);
      } else if (context.version === undefined) {
        const quote =
          preview?.type === "rich_text" && preview.elements.length === 1
            ? preview.elements[0]
            : undefined;
        const quotedText =
          quote?.type === "rich_text_quote" && quote.elements.length === 1
            ? quote.elements[0]
            : undefined;
        signedContent =
          quotedText?.type === "text"
            ? quotedText.text
            : preview?.type === "section" && preview.text?.type === "plain_text"
              ? preview.text.text
              : "";
        if (!signedContent || signedContent.length > MAX_TEXT) throw new Error("Invalid prompt");
      } else throw new Error("Invalid prompt version");
      if (
        !matchesHash(
          context.signature,
          digest(config.signingSecret, "dm-submission", [
            context.user,
            context.channel,
            context.ts,
            signedContent,
          ]),
        )
      )
        throw new Error("Invalid prompt");
      content = sanitized ?? contentFromText(signedContent);
    } catch {
      await reply("This confirmation is invalid. Send your confession to me again!");
      return;
    }
    const submissionId = `dm:${context.signature}`;
    const privateKey = digest(config.signingSecret, "dm-reply-key", [submissionId]);
    const useKey =
      body.state?.values.dm_ownership?.dm_passphrase?.selected_options?.some(
        (option) => option.value === "passphrase",
      ) ?? false;
    let post;
    try {
      [post] = await db
        .insert(confessions)
        .values({
          submissionId,
          text: content.text,
          content: content.block,
          postChannel: config.channels.post,
          ...(useKey
            ? { replyKeyHash: hashReplyKey(privateKey, body.user.id) }
            : await authorCredential(body.user.id, config.pepper)),
        })
        .onConflictDoNothing({ target: confessions.submissionId })
        .returning();
      post ??= await db.query.confessions.findFirst({
        where: eq(confessions.submissionId, submissionId),
      });
      if (!post || !(await ownsPost(post, body.user.id, privateKey, config.pepper)))
        throw new Error("Unavailable submission");
    } catch {
      await reply("Could not submit this confession. Please try again, or use `/owl`.");
      return;
    }
    const confirmation =
      post.status === "pending"
        ? `Confession #${post.id} submitted and awaiting review.`
        : `Confession #${post.id} was already submitted (${post.status}).`;
    const blocks: KnownBlock[] = [
      { type: "section", text: plain(confirmation) },
      {
        type: "section",
        text: plain(
          post.replyKeyHash
            ? `Your private reply key:\n${privateKey}\n\nYou should save it now. Replies, reactions, and withdrawal require this key and this Slack account.`
            : "Your Slack account will be recognized through its salted hash. No reply key is needed.",
        ),
      },
    ];
    await client.chat.update({
      channel: context.channel,
      ts: body.message!.ts,
      text: confirmation,
      blocks,
    });
    try {
      await db.transaction(async (tx) => {
        const [pending] = await tx
          .select()
          .from(confessions)
          .where(
            and(
              eq(confessions.id, post.id),
              eq(confessions.status, "pending"),
              isNull(confessions.reviewTs),
            ),
          )
          .for("update");
        if (!pending) return;
        const review = await client.chat.postMessage({
          channel: config.channels.review,
          text: `Anonymous post #${pending.id}`,
          blocks: reviewBlocks(pending.id, pending.text, pending.content),
          unfurl_links: false,
          unfurl_media: false,
        });
        if (!review.ts) throw new Error("Slack returned no review timestamp");
        await tx
          .update(confessions)
          .set({ reviewTs: review.ts, updatedAt: new Date() })
          .where(eq(confessions.id, pending.id));
      });
    } catch {
      await reply(
        `Confession #${post.id} is saved, but review delivery is delayed. Moderators can recover it with /owl-revive.`,
      );
    }
  });
}
