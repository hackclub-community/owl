import type { App, BlockAction, ButtonAction, MessageShortcut } from "@slack/bolt";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { WebClient } from "@slack/web-api";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { confessions, replies } from "../db/schema.js";
import { authorCredential, newReplyKey, ownsPost, replyKeyCredential } from "./security.js";
import { registerDmHandlers } from "./dm.js";
import { attributedTo } from "./demo.js";
import {
  contentBlocks,
  contentFromText,
  inputContent,
  storedContent,
  type Content,
} from "./content.js";
import {
  approveTwView,
  confirmationView,
  decisionBlocks,
  messageFallback,
  MAX_TEXT,
  postView,
  reactionView,
  noticeView,
  removedRepliesMessages,
  replyView,
  reviewBlocks,
  suspendRepliesView,
  withdrawView,
} from "./views.js";
function slackError(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    (error.data as { error?: string } | undefined)?.error === code
  );
}

const commandName = (name: string) => new RegExp(`^/(?:(?:.*-)?(?:dev|demo)-)?${name}$`);

export function registerHandlers(app: App, db: Database, config: Config) {
  registerDmHandlers(app, db, config);
  const cleared = () => ({
    status: "rejected" as const,
    text: "",
    content: null,
    replyKeyHash: null,
    authorHash: null,
    authorSalt: null,
    updatedAt: new Date(),
  });
  const published = (channel: string, ts: string) =>
    db.query.confessions.findFirst({
      where: and(
        eq(confessions.postChannel, channel),
        eq(confessions.postTs, ts),
        eq(confessions.status, "accepted"),
      ),
    });
  async function unpublish(
    post: typeof confessions.$inferSelect,
    client: WebClient,
    tx: Pick<Database, "select" | "delete"> = db,
  ) {
    const rows = await tx
      .select({ ts: replies.ts })
      .from(replies)
      .where(eq(replies.confessionId, post.id));
    for (const ts of [...rows.map((row) => row.ts), post.contentTs, post.postTs]) {
      if (!ts) continue;
      try {
        await client.chat.delete({ channel: post.postChannel, ts });
      } catch (error) {
        if (!slackError(error, "message_not_found")) throw error;
      }
    }
    await tx.delete(replies).where(eq(replies.confessionId, post.id));
  }
  async function withdraw(id: number, userId: string, key: string, client: WebClient) {
    const post = await db.query.confessions.findFirst({ where: eq(confessions.id, id) });
    if (!post || !(await ownsPost(post, userId, key, config.pepper))) return false;
    const [claimed] = await db
      .update(confessions)
      .set({ status: "withdrawing", updatedAt: new Date() })
      .where(
        and(
          eq(confessions.id, id),
          inArray(confessions.status, ["pending", "accepted", "withdrawing", "rejected"]),
        ),
      )
      .returning();
    if (!claimed) return false;
    await unpublish(claimed, client);
    await db.update(confessions).set(cleared()).where(eq(confessions.id, id));
    await Promise.all(
      claimed.reviewTs
        ? [
            client.chat.update({
              channel: config.channels.review,
              ts: claimed.reviewTs,
              text: `Post #${id} self-rejected`,
              blocks: [
                ...contentBlocks(
                  storedContent(claimed.text, claimed.content),
                  `Anonymous post #${id}`,
                ),
                {
                  type: "context",
                  elements: [
                    { type: "plain_text", text: `Post #${id} self-rejected by its author` },
                  ],
                },
              ],
            }),
          ]
        : [],
    );
    return true;
  }

  app.command(commandName("owl-self-reject"), async ({ ack, command, client, respond }) => {
    await ack();
    const s = command.text.trim();
    const id = Number(s);
    if (!/^\d+$/.test(s) || !Number.isSafeInteger(id) || id < 1) {
      await respond({ response_type: "ephemeral", text: "Usage: /owl-self-reject <id>" });
      return;
    }
    try {
      const post = await db.query.confessions.findFirst({ where: eq(confessions.id, id) });
      if (post?.replyKeyHash) {
        await client.views.open({ trigger_id: command.trigger_id, view: withdrawView(id) });
        return;
      }
      const success = await withdraw(id, command.user_id, "", client);
      await respond({
        response_type: "ephemeral",
        text: success
          ? `Post #${id} withdrawn.`
          : "No available post belongs to this account. A post being published cannot be withdrawn yet.",
      });
    } catch {
      await respond({
        response_type: "ephemeral",
        text: "Withdrawal could not be confirmed. Please try again; published content may already have been removed.",
      });
    }
  });

  app.view("self_reject_view", async ({ ack, body, view, client }) => {
    const id = Number(view.private_metadata);
    const key = view.state.values.key?.key?.value?.trim() ?? "";
    const post =
      Number.isSafeInteger(id) && id > 0
        ? await db.query.confessions.findFirst({ where: eq(confessions.id, id) })
        : undefined;
    if (
      !post ||
      !(await ownsPost(post, body.user.id, key, config.pepper)) ||
      !["pending", "accepted", "withdrawing", "rejected"].includes(post.status)
    ) {
      await ack({
        response_action: "errors",
        errors: { key: "Use this post’s private key and its original account." },
      });
      return;
    }
    await ack();
    await withdraw(id, body.user.id, key, client);
  });

  app.command(commandName("owl-revive"), async ({ ack, command, client, respond }) => {
    await ack();
    if (command.channel_id !== config.channels.review) {
      await respond({
        response_type: "ephemeral",
        text: "Run `/owl-revive` in the review channel silly goose!",
      });
      return;
    }
    const rows = await db
      .select({ id: confessions.id })
      .from(confessions)
      .where(and(eq(confessions.status, "pending"), isNull(confessions.reviewTs)))
      .orderBy(asc(confessions.id))
      .limit(50);
    let count = 0;
    for (const row of rows) {
      await db.transaction(async (tx) => {
        const [post] = await tx
          .select()
          .from(confessions)
          .where(
            and(
              eq(confessions.id, row.id),
              eq(confessions.status, "pending"),
              isNull(confessions.reviewTs),
            ),
          )
          .for("update", { skipLocked: true });
        if (!post) return;
        const review = await client.chat.postMessage({
          channel: config.channels.review,
          text: `Anonymous post #${post.id}`,
          blocks: reviewBlocks(post.id, post.text, post.content),
          unfurl_links: false,
          unfurl_media: false,
        });
        if (!review.ts) throw new Error("Slack returned no review timestamp");
        await tx
          .update(confessions)
          .set({ reviewTs: review.ts, updatedAt: new Date() })
          .where(eq(confessions.id, post.id));
        count++;
      });
    }
    await respond({
      response_type: "ephemeral",
      text: `recovered ${count} pending review message(s).`,
    });
  });

  const emojis = [
    "thumbsup",
    "thumbsdown",
    "heart",
    "tada",
    "smile",
    "joy",
    "sob",
    "eyes",
    "thinking_face",
    "fire",
    "100",
    "raised_hands",
    "clap",
    "wave",
    "pray",
    "sparkles",
    "white_check_mark",
    "rocket",
    "heart_eyes",
  ];
  app.options("emoji", async ({ ack, options }) => {
    const q = options.value.trim().replaceAll(":", "").toLowerCase();
    const names = emojis.filter((name) => name.includes(q));
    // emoji
    if (/^[a-z0-9_+-]{1,64}$/.test(q) && !names.includes(q)) names.unshift(q);
    await ack({
      options: names
        .slice(0, 100)
        .map((name) => ({ text: { type: "plain_text", text: `:${name}:` }, value: name })),
    });
  });
  app.shortcut<MessageShortcut>("react_anon", async ({ ack, shortcut, client }) => {
    await ack();
    const ts = shortcut.message.thread_ts ?? shortcut.message.ts;
    await client.views.open({
      trigger_id: shortcut.trigger_id,
      view: reactionView(shortcut.channel.id, ts, shortcut.message.ts),
    });
  });
  app.view("react_anon_view", async ({ ack, body, view, client }) => {
    const key = view.state.values.key?.key?.value?.trim() ?? "";
    const emoji = view.state.values.emoji?.emoji?.selected_option?.value ?? "";
    let context: { channel: string; ts: string; targetTs: string };
    try {
      context = JSON.parse(view.private_metadata);
      if (
        typeof context.channel !== "string" ||
        typeof context.ts !== "string" ||
        typeof context.targetTs !== "string"
      )
        throw new Error("Invalid context");
    } catch {
      await ack({
        response_action: "errors",
        errors: { emoji: "Reopen this form from the confession or its thread." },
      });
      return;
    }
    if (!/^[a-zA-Z0-9_+-]{1,64}$/.test(emoji)) {
      await ack({ response_action: "errors", errors: { emoji: "Choose an emoji." } });
      return;
    }
    const post = await published(context.channel, context.ts);
    if (!post || !(await ownsPost(post, body.user.id, key, config.pepper))) {
      await ack({
        response_action: "errors",
        errors: { key: "Use the original account, plus its private key if you chose that option." },
      });
      return;
    }
    await ack();
    try {
      await client.reactions.add({
        channel: context.channel,
        timestamp: context.targetTs,
        name: emoji,
      });
    } catch (error) {
      if (slackError(error, "already_reacted")) {
        await client.reactions.remove({
          channel: context.channel,
          timestamp: context.targetTs,
          name: emoji,
        });
      } else {
        await client.chat.postEphemeral({
          channel: context.channel,
          user: body.user.id,
          text: "Could not toggle the reaction. Check that the emoji and message exist before trying again.",
        });
      }
    }
  });
  app.command(commandName("owl"), async ({ ack, command, client, respond }) => {
    await ack();
    try {
      await client.views.open({
        trigger_id: command.trigger_id,
        view: postView(command.text.trim(), config.demo),
      });
    } catch (error) {
      const data =
        typeof error === "object" && error !== null && "data" in error
          ? (error.data as { error?: unknown })
          : undefined;
      console.error(
        "owl form open failed:",
        typeof data?.error === "string" ? data.error : "unknown_error",
      );
      await respond({
        response_type: "ephemeral",
        text: "Could not open the form. Please try /owl again.",
      });
    }
  });

  app.view("anon_post_view", async ({ ack, view, body, client }) => {
    let content: Content;
    try {
      content = inputContent(view.state.values.text?.text);
      if (config.demo) content = await attributedTo(client, body.user.id, content);
    } catch {
      await ack({
        response_action: "errors",
        errors: {
          text: `Use supported text, links, channels, and emoji (1–${MAX_TEXT} characters).`,
        },
      });
      return;
    }
    const mode = view.state.values.ownership?.mode?.selected_option?.value;
    if (mode !== "account" && mode !== "passphrase") {
      await ack({
        response_action: "errors",
        errors: { ownership: "Choose an ownership option." },
      });
      return;
    }
    const key = mode === "passphrase" ? newReplyKey() : null;
    let confession;
    try {
      [confession] = await db
        .insert(confessions)
        .values({
          submissionId: view.id,
          text: content.text,
          content: content.block,
          ...(key
            ? await replyKeyCredential(key, body.user.id, config.pepper)
            : await authorCredential(body.user.id, config.pepper)),
          postChannel: config.channels.post,
        })
        .onConflictDoNothing({ target: confessions.submissionId })
        .returning();
    } catch {
      await ack({
        response_action: "errors",
        errors: { text: "Could not save your post. Please try again." },
      });
      return;
    }
    if (!confession) {
      await ack({ response_action: "clear" });
      return;
    }
    await ack({ response_action: "update", view: confirmationView(confession.id, key) });
    const review = await client.chat.postMessage({
      channel: config.channels.review,
      text: `Anonymous post #${confession.id}`,
      blocks: reviewBlocks(confession.id, content.text, content.block),
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!review.ts) throw new Error("Slack returned no review timestamp");
    await db
      .update(confessions)
      .set({ reviewTs: review.ts, updatedAt: new Date() })
      .where(eq(confessions.id, confession.id));
  });

  async function decide(
    id: number,
    reviewTs: string,
    userId: string,
    accepting: boolean,
    postChannel: string,
    client: WebClient,
    warning: string | null = null,
  ) {
    const reviewedAt = new Date();
    const [confession] = await db
      .update(confessions)
      .set({
        status: accepting ? "publishing" : "rejected",
        ...(accepting ? { postChannel, warning } : {}),
        updatedAt: reviewedAt,
      })
      .where(
        and(
          eq(confessions.id, id),
          eq(confessions.status, "pending"),
          eq(confessions.reviewTs, reviewTs),
        ),
      )
      .returning();
    if (!confession) return false;
    if (accepting) {
      const content = storedContent(confession.text, confession.content);
      const top = warning ? contentFromText(`TW - ${warning}`) : content;
      const published = await client.chat.postMessage({
        channel: confession.postChannel,
        text: messageFallback(`${id}: ${top.text}`),
        mrkdwn: false,
        parse: "none",
        link_names: false,
        blocks: contentBlocks(top, String(id), true),
        unfurl_links: false,
        unfurl_media: false,
      });
      if (!published.ts) throw new Error("Slack returned no publication timestamp");
      await db.update(confessions).set({ postTs: published.ts }).where(eq(confessions.id, id));
      let contentTs: string | null = null;
      if (warning) {
        const reply = await client.chat.postMessage({
          channel: confession.postChannel,
          thread_ts: published.ts,
          reply_broadcast: false,
          text: messageFallback(content.text),
          mrkdwn: false,
          parse: "none",
          link_names: false,
          blocks: contentBlocks(content),
          unfurl_links: false,
          unfurl_media: false,
        });
        if (!reply.ts) throw new Error("Slack returned no content timestamp");
        contentTs = reply.ts;
      }
      await db
        .update(confessions)
        .set({ status: "accepted", contentTs, postTs: published.ts, updatedAt: reviewedAt })
        .where(eq(confessions.id, id));
    }
    const verdict = accepting ? "accepted" : "rejected";
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(confessions)
        .where(
          and(
            eq(confessions.id, id),
            eq(confessions.status, verdict),
            eq(confessions.updatedAt, reviewedAt),
          ),
        )
        .for("update");
      if (!current?.text) return;
      const logVerdict = accepting ? `approved to <#${current.postChannel}>` : "rejected";
      const log = await client.chat.postMessage({
        channel: config.channels.log,
        text: `Confession *#${id}* was *${logVerdict}*`,
        mrkdwn: true,
        parse: "none",
        link_names: false,
      });
      async function permalink(channel: string, ts?: string | null) {
        if (!ts) return undefined;
        try {
          const result = await client.chat.getPermalink({ channel, message_ts: ts });
          return result.permalink;
        } catch (error) {
          console.error("cant get decision message permalink? Somethings wrong...", error);
          return undefined;
        }
      }
      const [logUrl, postUrl] = await Promise.all([
        permalink(config.channels.log, log.ts),
        accepting ? permalink(current.postChannel, current.postTs) : undefined,
      ]);
      await client.chat.update({
        channel: config.channels.review,
        ts: reviewTs,
        text: `Post #${id} ${accepting ? `Approved to <#${current.postChannel}>` : "Rejected"}`,
        blocks: decisionBlocks(
          id,
          current.text,
          verdict,
          userId,
          reviewedAt.getTime(),
          warning,
          current.content,
          { postChannel: current.postChannel, logUrl, postUrl },
        ),
      });
    });
    return true;
  }

  for (const actionId of ["accept_confession", "accept_meta", "reject_confession"] as const) {
    app.action<BlockAction<ButtonAction>>(
      actionId,
      async ({ ack, body, action, client, respond }) => {
        await ack();
        if (body.channel?.id !== config.channels.review || !body.message?.ts) return;
        const id = Number(action.value);
        if (!Number.isSafeInteger(id) || id < 1) return;
        if (
          !(await decide(
            id,
            body.message.ts,
            body.user.id,
            actionId !== "reject_confession",
            actionId === "accept_meta" ? config.channels.meta : config.channels.post,
            client,
          ))
        ) {
          await respond({
            response_type: "ephemeral",
            replace_original: false,
            text: "this has already been reviewed! thank u for ur efforts anyway! its the spirit that counts",
          });
        }
      },
    );
  }

  app.action<BlockAction<ButtonAction>>("accept_tw", async ({ ack, body, action, client }) => {
    await ack();
    if (body.channel?.id !== config.channels.review || !body.message?.ts) return;
    const id = Number(action.value);
    if (!Number.isSafeInteger(id) || id < 1) return;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: approveTwView(id, body.message.ts),
    });
  });

  app.view("approve_tw_view", async ({ ack, body, view, client }) => {
    const warning = view.state.values.warning?.warning?.value?.trim() ?? "";
    if (!warning || warning.length > 64) {
      await ack({
        response_action: "errors",
        errors: { warning: "Enter a warning between 1 and 64 characters." },
      });
      return;
    }
    let context: { id: number; reviewTs: string };
    try {
      context = JSON.parse(view.private_metadata);
      if (
        !context ||
        !Number.isSafeInteger(context.id) ||
        context.id < 1 ||
        typeof context.reviewTs !== "string" ||
        !context.reviewTs
      )
        throw new Error("Invalid context");
    } catch {
      await ack({
        response_action: "errors",
        errors: { warning: "Reopen this form from the review message." },
      });
      return;
    }
    await ack();
    try {
      const accepted = await decide(
        context.id,
        context.reviewTs,
        body.user.id,
        true,
        config.channels.post,
        client,
        warning,
      );
      if (accepted) return;
      await client.chat.postEphemeral({
        channel: config.channels.review,
        user: body.user.id,
        text: "This post has already been reviewed or withdrawn. Nothing was published.",
      });
    } catch {
      await client.chat.postEphemeral({
        channel: config.channels.review,
        user: body.user.id,
        text: "TW approval could not be confirmed. Check the destination thread before retrying; delivery may be partial.",
      });
    }
  });

  app.action<BlockAction<ButtonAction>>(
    "undo_review",
    async ({ ack, body, action, client, respond }) => {
      await ack();
      if (body.channel?.id !== config.channels.review || !body.message?.ts) return;
      const parts = action.value?.split(":") ?? [];
      if (parts.length !== 2 || !parts.every((part) => /^\d+$/.test(part))) return;
      const [id, revision] = parts.map(Number);
      if (!Number.isSafeInteger(id) || !id || !Number.isSafeInteger(revision)) return;
      let undone: "unapproved" | "unrejected" | null = null;
      try {
        await db.transaction(async (tx) => {
          const [post] = await tx
            .select()
            .from(confessions)
            .where(and(eq(confessions.id, id!), eq(confessions.reviewTs, body.message!.ts)))
            .for("update");
          if (
            !post ||
            !["accepted", "rejected"].includes(post.status) ||
            post.updatedAt.getTime() !== revision ||
            !post.text ||
            (!post.replyKeyHash && (!post.authorHash || !post.authorSalt))
          )
            return;
          if (post.status === "accepted") {
            if (!post.postTs) throw new Error("No publication timestamp");
            await unpublish(post, client, tx);
          }
          await tx
            .update(confessions)
            .set({
              status: "pending",
              postTs: null,
              contentTs: null,
              warning: null,
              updatedAt: new Date(),
            })
            .where(eq(confessions.id, post.id));
          await client.chat.update({
            channel: config.channels.review,
            ts: body.message!.ts,
            text: `Anonymous post #${post.id} awaiting review`,
            blocks: reviewBlocks(post.id, post.text, post.content),
          });
          undone = post.status === "accepted" ? "unapproved" : "unrejected";
        });
      } catch {
        await respond({
          response_type: "ephemeral",
          replace_original: false,
          text: "Undo could not be confirmed. Retry Undo; the published message may already have been removed.",
        });
        return;
      }
      if (!undone) {
        await respond({
          response_type: "ephemeral",
          replace_original: false,
          text: "This decision has already changed, or the post was withdrawn. Nothing was undone.",
        });
        return;
      }
      await client.chat.postMessage({
        channel: config.channels.log,
        text: `Confession *#${id}* was *${undone}*`,
        mrkdwn: true,
        parse: "none",
        link_names: false,
      });
    },
  );

  app.shortcut<MessageShortcut>("reply_anon", async ({ ack, shortcut, client }) => {
    await ack();
    await client.views.open({
      trigger_id: shortcut.trigger_id,
      view: replyView(shortcut.channel.id, shortcut.message.thread_ts ?? shortcut.message.ts),
    });
  });

  app.view("reply_anon_view", async ({ ack, view, body, client }) => {
    const key = view.state.values.key?.key?.value?.trim() ?? "";
    let content: Content;
    try {
      content = inputContent(view.state.values.text?.text);
      if (config.demo) content = await attributedTo(client, body.user.id, content);
    } catch {
      await ack({
        response_action: "errors",
        errors: {
          text: `Use supported text, links, channels, and emoji (1–${MAX_TEXT} characters).`,
        },
      });
      return;
    }
    let context: { channel: string; ts: string };
    try {
      context = JSON.parse(view.private_metadata);
      if (typeof context.channel !== "string" || typeof context.ts !== "string")
        throw new Error("Invalid context");
    } catch {
      await ack({
        response_action: "errors",
        errors: { text: "Reopen this form from the post you want to reply to." },
      });
      return;
    }
    let confession;
    try {
      confession = await published(context.channel, context.ts);
    } catch {
      await ack({
        response_action: "errors",
        errors: { key: "Could not verify the key. Please try again." },
      });
      return;
    }
    if (confession?.repliesLockedAt) {
      await ack({
        response_action: "errors",
        errors: { text: "Anonymous replies to this post have been suspended." },
      });
      return;
    }
    if (!confession || !(await ownsPost(confession, body.user.id, key, config.pepper))) {
      await ack({
        response_action: "errors",
        errors: {
          key: "Use the original account, plus its private reply key if you chose that option.",
        },
      });
      return;
    }
    await ack();
    let ts: string | undefined;
    try {
      ({ ts } = await client.chat.postMessage({
        channel: confession.postChannel,
        thread_ts: confession.postTs!,
        text: messageFallback(content.text),
        mrkdwn: false,
        parse: "none",
        link_names: false,
        blocks: contentBlocks(content),
        unfurl_links: false,
        unfurl_media: false,
      }));
      if (!ts) throw new Error("Slack returned no reply timestamp");
      // lock the post so a concurrent unapprove/withdraw either sees this reply or we drop it
      const kept = await db.transaction(async (tx) => {
        const [current] = await tx
          .select({ id: confessions.id })
          .from(confessions)
          .where(
            and(
              eq(confessions.id, confession.id),
              eq(confessions.status, "accepted"),
              eq(confessions.postTs, confession.postTs!),
              isNull(confessions.repliesLockedAt),
            ),
          )
          .for("share");
        if (!current) return false;
        await tx.insert(replies).values({ confessionId: confession.id, ts: ts! });
        return true;
      });
      if (!kept) await client.chat.delete({ channel: confession.postChannel, ts });
    } catch {
      // an untracked reply could never be cleaned up, so drop it
      if (ts) await client.chat.delete({ channel: confession.postChannel, ts }).catch(() => {});
      await client.chat.postEphemeral({
        channel: confession.postChannel,
        user: body.user.id,
        text: "Your anonymous reply could not be confirmed. Check the thread before trying again.",
      });
    }
  });

  async function isReviewer(client: WebClient, userId: string) {
    let cursor: string | undefined;
    do {
      const page = await client.conversations.members({
        channel: config.channels.review,
        limit: 1000,
        cursor,
      });
      if (page.members?.includes(userId)) return true;
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return false;
  }
  async function suspendTargets(
    post: typeof confessions.$inferSelect,
    targetTs: string,
    tx: Pick<Database, "select"> = db,
  ) {
    const rows = await tx
      .select({ ts: replies.ts })
      .from(replies)
      .where(eq(replies.confessionId, post.id));
    if (!rows.some((row) => row.ts === targetTs)) return [];
    return rows.map((row) => row.ts).filter((ts) => ts >= targetTs);
  }
  async function threadContents(client: WebClient, channel: string, ts: string) {
    const contents = new Map<string, Content>();
    let cursor: string | undefined;
    do {
      const page = await client.conversations.replies({ channel, ts, limit: 200, cursor });
      for (const message of page.messages ?? []) {
        try {
          contents.set(message.ts!, storedContent(message.text ?? "", message.blocks ?? null));
        } catch {}
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return contents;
  }

  app.shortcut<MessageShortcut>("suspend_replies", async ({ ack, shortcut, client }) => {
    await ack();
    const notice = (text: string) =>
      client.views.open({
        trigger_id: shortcut.trigger_id,
        view: noticeView("Suspend anon replies", text),
      });
    const ts = shortcut.message.thread_ts ?? shortcut.message.ts;
    const [reviewer, post] = await Promise.all([
      isReviewer(client, shortcut.user.id),
      published(shortcut.channel.id, ts),
    ]);
    if (!reviewer) {
      await notice("Only people in the review channel can suspend anonymous replies.");
      return;
    }
    if (!post) {
      await notice("Use this on a published confession or a message in its thread.");
      return;
    }
    const targets = await suspendTargets(post, shortcut.message.ts);
    if (post.repliesLockedAt && !targets.length) {
      await notice(`Anonymous replies to post #${post.id} are already suspended.`);
      return;
    }
    await client.views.open({
      trigger_id: shortcut.trigger_id,
      view: suspendRepliesView(
        post.id,
        shortcut.channel.id,
        ts,
        shortcut.message.ts,
        targets.length,
        !!post.repliesLockedAt,
      ),
    });
  });

  app.view("suspend_replies_view", async ({ ack, body, view, client }) => {
    const context: { channel: string; ts: string; targetTs: string } = JSON.parse(
      view.private_metadata,
    );
    if (!(await isReviewer(client, body.user.id))) {
      await ack({
        response_action: "update",
        view: noticeView(
          "Suspend anon replies",
          "Only people in the review channel can suspend anonymous replies.",
        ),
      });
      return;
    }
    await ack();
    const post = await published(context.channel, context.ts);
    if (!post) return;
    const targets = await suspendTargets(post, context.targetTs);
    const contents = targets.length
      ? await threadContents(client, post.postChannel, post.postTs!)
      : new Map<string, Content>();
    const fresh = !post.repliesLockedAt;
    if (fresh) {
      await db
        .update(confessions)
        .set({ repliesLockedAt: new Date() })
        .where(eq(confessions.id, post.id));
      const notice = "OP has been suspended from further anonymous replies on this post.";
      await client.chat.postMessage({
        channel: post.postChannel,
        thread_ts: post.postTs!,
        text: notice,
        blocks: [{ type: "context", elements: [{ type: "plain_text", text: notice }] }],
        mrkdwn: false,
        parse: "none",
        link_names: false,
      });
    }
    if (fresh || targets.length) {
      const removed = `${targets.length} anonymous ${targets.length === 1 ? "reply" : "replies"}`;
      const heading = fresh
        ? `<@${body.user.id}> suspended anonymous replies on post #${post.id}${targets.length ? ` and removed ${removed}` : ""}`
        : `<@${body.user.id}> removed ${removed} on post #${post.id}`;
      const records = targets.map((ts) => ({ ts, content: contents.get(ts) ?? null }));
      for (const message of removedRepliesMessages(heading, records))
        await client.chat.postMessage({
          channel: config.channels.review,
          ...(post.reviewTs ? { thread_ts: post.reviewTs } : {}),
          ...message,
          unfurl_links: false,
          unfurl_media: false,
        });
    }
    for (const ts of targets) {
      try {
        await client.chat.delete({ channel: post.postChannel, ts });
      } catch (error) {
        if (!slackError(error, "message_not_found")) throw error;
      }
    }
    if (targets.length)
      await db
        .delete(replies)
        .where(and(eq(replies.confessionId, post.id), inArray(replies.ts, targets)));
  });
}
