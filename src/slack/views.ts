import type { ModalView, KnownBlock, InputBlock } from "@slack/web-api";

import {
  contentBlocks,
  contentFromText,
  storedContent,
  MAX_TEXT,
  type Content,
} from "./content.js";
export { MAX_TEXT } from "./content.js";
export const DEMO_NOTICE =
  "This is a demo of Owl, it is NOT anonymous. Your name is shown on everything you post.";
export const escapeSlackText = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export const MAX_MESSAGE_TEXT = 40_000;
// because apparently you can do this shit?
export function messageFallback(text: string): string {
  const escaped = escapeSlackText(text);
  if (escaped.length <= MAX_MESSAGE_TEXT) return escaped;
  let fallback = "";
  for (const character of text) {
    const escapedCharacter = escapeSlackText(character);
    if (fallback.length + escapedCharacter.length > MAX_MESSAGE_TEXT - 1) break;
    fallback += escapedCharacter;
  }
  return `${fallback}…`;
}
const plain = (text: string) => ({ type: "plain_text" as const, text });
const input = (id: string, label: string, multiline = false, optional = false): InputBlock => ({
  type: "input",
  block_id: id,
  label: plain(label),
  optional,
  element: {
    type: "plain_text_input",
    action_id: id,
    multiline,
    max_length: multiline ? MAX_TEXT : 64,
  },
});
const key = () => input("key", "Private reply key (leave blank for account hash)", false, true);
const messageInput = (label: string, initialText = ""): InputBlock => ({
  type: "input",
  block_id: "text",
  label: plain(label),
  hint: plain(`Up to ${MAX_TEXT.toLocaleString("en-US")} characters.`),
  element: {
    type: "rich_text_input",
    action_id: "text",
    focus_on_load: true,
    ...(initialText.trim() ? { initial_value: contentFromText(initialText).block } : {}),
  },
});
const confirmDialog = (
  title: string,
  text: string,
  confirmText: string,
  denyText: string,
  btnStyle: "primary" | "danger" = "primary",
) => ({
  title: plain(title),
  text: plain(text),
  confirm: plain(confirmText),
  deny: plain(denyText),
  style: btnStyle,
});
export function postView(initialText = "", demo = false): ModalView {
  return {
    type: "modal",
    callback_id: "anon_post_view",
    title: plain("New anonymous post"),
    submit: plain("Submit"),
    close: plain("Cancel"),
    blocks: [
      ...(demo ? [{ type: "context" as const, elements: [plain(DEMO_NOTICE)] }] : []),
      messageInput("Your message", initialText),
      {
        type: "input",
        block_id: "ownership",
        label: plain("How should we recognize your replies?"),
        element: {
          type: "radio_buttons",
          action_id: "mode",
          initial_option: {
            text: plain("Slack account hash"),
            value: "account",
            description: plain("Automatically recognizes this account using a salted hash."),
          },
          options: [
            {
              text: plain("Slack account hash"),
              value: "account",
              description: plain("Automatically recognizes this account using a salted hash."),
            },
            {
              text: plain("Private reply key"),
              value: "passphrase",
              description: plain(
                "Requires this account and a generated secret you save. (more secure)",
              ),
            },
          ],
        },
      },
    ],
  };
}
export function withdrawView(id: number): ModalView {
  return {
    type: "modal",
    callback_id: "self_reject_view",
    title: plain("Withdraw your post"),
    private_metadata: String(id),
    submit: plain("Withdraw"),
    close: plain("Cancel"),
    blocks: [input("key", "Private reply key")],
  };
}
export function reactionView(channel: string, ts: string, targetTs: string): ModalView {
  return {
    type: "modal",
    callback_id: "react_anon_view",
    title: plain("React anonymously"),
    private_metadata: JSON.stringify({ channel, ts, targetTs }),
    submit: plain("Toggle reaction"),
    close: plain("Cancel"),
    blocks: [
      {
        type: "input",
        block_id: "emoji",
        label: plain("Emoji"),
        element: {
          type: "external_select",
          action_id: "emoji",
          min_query_length: 0,
          placeholder: plain("Choose an emoji"),
        },
      },
      {
        type: "context",
        elements: [plain("Choosing the same emoji again removes your anonymous reaction.")],
      },
      key(),
    ],
  };
}
export function confirmationView(id: number, key: string | null): ModalView {
  return {
    type: "modal",
    title: plain("Post submitted"),
    close: plain("Done"),
    blocks: [
      {
        type: "section",
        text: plain(
          `Post #${id} is awaiting review.\n\n${key ? `Your private reply key:\n${key}\n\nSave it now. You will need this key and this Slack account to reply.` : "Your Slack account will be recognized through its salted hash. No reply key is needed."}\n\nUse “Reply anonymously” on your approved post to reply.`,
        ),
      },
    ],
  };
}
export function noticeView(title: string, text: string): ModalView {
  return {
    type: "modal",
    title: plain(title),
    close: plain("Close"),
    blocks: [{ type: "section", text: plain(text) }],
  };
}
export function replyView(channel: string, ts: string): ModalView {
  return {
    type: "modal",
    callback_id: "reply_anon_view",
    title: plain("Reply anonymously"),
    private_metadata: JSON.stringify({ channel, ts }),
    submit: plain("Reply"),
    close: plain("Cancel"),
    blocks: [messageInput("Your reply"), key()],
  };
}
export function suspendRepliesView(
  id: number,
  channel: string,
  ts: string,
  targetTs: string,
  count: number,
  locked: boolean,
): ModalView {
  const blocking = locked
    ? `Anonymous replies to post #${id} are already suspended`
    : `Blocks OP from replying anonymously to post #${id} again, posts a notice in the thread`;
  const replies = `${count} anonymous ${count === 1 ? "reply" : "replies"}`;
  const deleting = count
    ? `Deletes ${replies}`
    : "Deletes nothing (use the action on the first offending reply to delete it)";
  return {
    type: "modal",
    callback_id: "suspend_replies_view",
    title: plain("Suspend anon replies"),
    private_metadata: JSON.stringify({ channel, ts, targetTs }),
    submit: plain(count ? (locked ? `Delete ${count}` : `Delete ${count} and suspend`) : "Suspend"),
    close: plain("Cancel"),
    blocks: [
      { type: "section", text: plain(blocking) },
      { type: "section", text: plain(deleting) },
    ],
  };
}
export function removedRepliesMessages(
  heading: string,
  removed: { ts: string; content: Content | null }[],
): { text: string; blocks: KnownBlock[] }[] {
  const messages: { blocks: KnownBlock[]; length: number }[] = [
    { blocks: [{ type: "section", text: { type: "mrkdwn", text: heading } }], length: 0 },
  ];
  removed.forEach(({ ts, content }, index) => {
    const seconds = Math.floor(Number(ts));
    const blocks: KnownBlock[] = [
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Deleted reply ${index + 1}/${removed.length} (<!date^${seconds}^{date_short_pretty} at {time}|${new Date(seconds * 1000).toISOString()}>)`,
          },
        ],
      },
      ...(content
        ? contentBlocks(content)
        : [
            {
              type: "context" as const,
              elements: [plain("Already gone from Slack?")],
            },
          ]),
    ];
    const length = content?.text.length ?? 0;
    const current = messages.at(-1)!;
    if (current.blocks.length + blocks.length > 50 || current.length + length > MAX_TEXT)
      messages.push({ blocks, length });
    else {
      current.blocks.push(...blocks);
      current.length += length;
    }
  });
  return messages.map(({ blocks }, index) => ({
    text: index ? `${heading} (continued)` : heading,
    blocks,
  }));
}
export function approveTwView(id: number, reviewTs: string): ModalView {
  return {
    type: "modal",
    callback_id: "approve_tw_view",
    title: plain("Approve with TW"),
    private_metadata: JSON.stringify({ id, reviewTs }),
    submit: plain("Approve"),
    close: plain("Cancel"),
    blocks: [input("warning", "whats the warning? (like self harm etc)")],
  };
}
export function decisionBlocks(
  id: number,
  text: string,
  verdict: "accepted" | "rejected",
  userId: string,
  revision: number,
  warning?: string | null,
  block?: unknown,
  links: { postChannel?: string; logUrl?: string; postUrl?: string } = {},
): KnownBlock[] {
  const status =
    verdict === "accepted"
      ? `Approved${links.postChannel ? ` to <#${links.postChannel}>` : ""}`
      : "Rejected";
  return [
    ...contentBlocks(storedContent(text, block), `Anonymous post #${id}`),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Post #${id} ${status} by <@${userId}>${warning ? ` — TW - ${escapeSlackText(warning)}` : ""}`,
        },
        ...(links.logUrl
          ? [{ type: "mrkdwn" as const, text: `<${links.logUrl}|View community log>` }]
          : []),
        ...(verdict === "accepted" && links.postUrl
          ? [{ type: "mrkdwn" as const, text: `<${links.postUrl}|View posted message>` }]
          : []),
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "undo_review",
          value: `${id}:${revision}`,
          text: plain("Undo decision"),
          confirm: confirmDialog(
            "Undo decision?",
            verdict === "accepted"
              ? "Delete the published message and return this post to pending review? Existing thread replies may remain."
              : "Return this rejected post to pending review?",
            "Undo",
            "Cancel",
          ),
        },
      ],
    },
  ];
}
export function reviewBlocks(id: number, text: string, block?: unknown): KnownBlock[] {
  return [
    ...contentBlocks(storedContent(text, block), `Anonymous post #${id}`),
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "accept_confession",
          value: String(id),
          text: plain("Post to confessions"),
          style: "primary",
        },
        {
          type: "button",
          action_id: "accept_tw",
          value: String(id),
          text: plain("Approve with TW"),
        },
        {
          type: "button",
          action_id: "accept_meta",
          value: String(id),
          text: plain("Post to #meta"),
          confirm: confirmDialog(
            "Send to #meta?",
            "Are you super duper sure you want to send this to the pits of #meta?",
            "Yes!",
            "Nope!",
          ),
        },
        {
          type: "button",
          action_id: "reject_confession",
          value: String(id),
          text: plain("Reject"),
          style: "danger",
        },
      ],
    },
  ];
}
