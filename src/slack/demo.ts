import type { WebClient } from "@slack/web-api";
import { contentFromBlocks, type Content } from "./content.js";
import { escapeSlackText } from "./views.js";

const profile = (user: string) => `https://app.slack.com/team/${user}`;

export async function nameOf(client: WebClient, user: string) {
  try {
    const { user: info } = await client.users.info({ user });
    return info?.profile?.display_name || info?.real_name || user;
  } catch {
    return user;
  }
}

export function attributed(content: Content, user: string, name: string): Content {
  return contentFromBlocks({
    ...content.block,
    elements: [
      ...content.block.elements,
      {
        type: "rich_text_section",
        elements: [
          { type: "text", text: "— ", style: { italic: true } },
          { type: "link", url: profile(user), text: name, style: { italic: true } },
        ],
      },
    ],
  });
}

export async function attributedTo(client: WebClient, user: string, content: Content) {
  return attributed(content, user, await nameOf(client, user));
}

// " by <name>" for a log line in mrkdwn
export async function byline(client: WebClient, user: string, demo: boolean) {
  if (!demo) return "";
  const name = escapeSlackText(await nameOf(client, user)).replaceAll("|", "¦");
  return ` by <${profile(user)}|${name}>`;
}
