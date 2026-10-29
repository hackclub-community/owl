import type { WebClient } from "@slack/web-api";
import { contentFromBlocks, type Content } from "./content.js";

export const DEMO_NOTICE =
  "This is a demo of Owl, it is NOT anonymous. Your name is shown on everything you post.";

export function attributed(content: Content, user: string, name: string): Content {
  return contentFromBlocks({
    ...content.block,
    elements: [
      {
        type: "rich_text_section",
        elements: [
          { type: "text", text: "from " },
          {
            type: "link",
            url: `https://app.slack.com/team/${user}`,
            text: name,
            style: { bold: true },
          },
          { type: "text", text: " (demo)", style: { italic: true } },
        ],
      },
      ...content.block.elements,
    ],
  });
}

export async function attributedTo(client: WebClient, user: string, content: Content) {
  let name = user;
  try {
    const { user: info } = await client.users.info({ user });
    name = info?.profile?.display_name || info?.real_name || user;
  } catch {}
  return attributed(content, user, name);
}
