import type { ModalView, KnownBlock, InputBlock } from "@slack/web-api";

import { contentBlocks, contentFromText, storedContent, MAX_TEXT } from "./content.js";
export { MAX_TEXT } from "./content.js";
export const escapeSlackText = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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
  element: {
    type: "rich_text_input",
    action_id: "text",
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
export function postView(initialText = ""): ModalView {
  return {
    type: "modal",
    callback_id: "anon_post_view",
    title: plain("New anonymous post"),
    submit: plain("Submit"),
    close: plain("Cancel"),
    blocks: [
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
      key(),
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
export function replyView(channel: string, ts: string): ModalView {
  return {
    type: "modal",
    callback_id: "reply_anon_view",
    title: plain("Reply anonymously"),
    private_metadata: JSON.stringify({ channel, ts }),
    submit: plain("Reply"),
    close: plain("Cancel"),
    blocks: [key(), messageInput("Your reply")],
  };
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
): KnownBlock[] {
  return [
    ...contentBlocks(storedContent(text, block), `Anonymous post #${id}`),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Post #${id} ${verdict} by <@${userId}>${warning ? ` — TW - ${escapeSlackText(warning)}` : ""}`,
        },
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
            "Post to #meta",
            "Are you sure you want to approve this confession for #meta?",
            "Approve",
            "Deny",
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
