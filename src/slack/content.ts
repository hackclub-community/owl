import type {
  RichTextBlock,
  RichTextBlockElement,
  RichTextElement,
  RichTextText,
} from "@slack/web-api";

export type Content = { block: RichTextBlock; text: string };
export const MAX_TEXT = 12_000;
export const MAX_BLOCK_TEXT = 2800;
export const MAX_CONTENT_BYTES = 48 * 1024;

const invalid = (): never => {
  throw new Error("invalid or unsupported rich-text content");
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string") return invalid();
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || !value.length) return invalid();
  return value;
}
function boundedJSON(value: unknown): void {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return invalid();
  }
  if (!json || Buffer.byteLength(json, "utf8") > MAX_CONTENT_BYTES) {
    throw new Error("Content JSON must not exceed 48KB");
  }
}
function safeURL(value: string): boolean {
  // oxlint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f<>\\]/u.test(value)) return false;
  if (!/^(?:https?:\/\/|mailto:)/i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "mailto:"
      ? Boolean(url.pathname)
      : Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}
function style(value: unknown): RichTextText["style"] {
  if (value === undefined) return undefined;
  const source = object(value);
  const result: NonNullable<RichTextText["style"]> = {};
  for (const key of ["bold", "italic", "strike", "code", "underline"] as const) {
    if (source[key] !== undefined) {
      if (typeof source[key] !== "boolean") return invalid();
      result[key] = source[key];
    }
  }
  return Object.keys(result).length ? result : undefined;
}
function id(value: unknown, prefix: string): string {
  const result = string(value);
  if (!new RegExp(`^[${prefix}][A-Z0-9]+$`).test(result)) return invalid();
  return result;
}
function inline(value: unknown): RichTextElement {
  const node = object(value);
  const formatting = style(node.style);
  const styled = formatting ? { style: formatting } : {};
  switch (node.type) {
    case "text":
      return { type: "text", text: string(node.text), ...styled };
    case "link": {
      const url = string(node.url);
      const text = node.text === undefined ? undefined : string(node.text);
      if (!safeURL(url)) return { type: "text", text: text ?? url, ...styled };
      return { type: "link", url, ...(text === undefined ? {} : { text }), ...styled };
    }
    case "message_mention": {
      const channel = id(node.channel_id, "CG");
      const timestamp = string(node.message_ts);
      if (!/^\d+\.\d{6}$/.test(timestamp)) return invalid();
      const thread = node.thread_ts === undefined ? undefined : string(node.thread_ts);
      if (thread !== undefined && !/^\d+\.\d{6}$/.test(thread)) return invalid();
      const url =
        node.url === undefined
          ? `https://app.slack.com/archives/${channel}/p${timestamp.replace(".", "")}${thread === undefined ? "" : `?thread_ts=${thread}&cid=${channel}`}`
          : string(node.url);
      return inline({ type: "link", url, text: node.text, style: formatting });
    }
    case "emoji": {
      const name = string(node.name);
      if (!/^[a-zA-Z0-9_+-]+$/.test(name)) return invalid();
      const unicode = node.unicode === undefined ? undefined : string(node.unicode);
      if (unicode !== undefined && !/^[0-9a-f]{1,6}(?:-[0-9a-f]{1,6})*$/i.test(unicode))
        return invalid();
      if (
        unicode !== undefined &&
        unicode.split("-").some((part) => {
          const point = parseInt(part, 16);
          return (
            point > 0x10ffff ||
            (point >= 0xd800 && point <= 0xdfff) ||
            point < 0x20 ||
            point === 0x7f
          );
        })
      )
        return invalid();
      return { type: "emoji", name, ...(unicode === undefined ? {} : { unicode }), ...styled };
    }
    case "channel":
      return { type: "channel", channel_id: id(node.channel_id, "CG"), ...styled };
    case "user":
      return { type: "text", text: `@${id(node.user_id, "UW")}`, ...styled };
    case "usergroup":
      return { type: "text", text: `@${id(node.usergroup_id, "S")}`, ...styled };
    case "broadcast": {
      if (!["here", "channel", "everyone"].includes(string(node.range))) return invalid();
      return { type: "text", text: `@${node.range}`, ...styled };
    }
    default:
      return invalid();
  }
}
function border(node: Record<string, unknown>): { border?: 0 | 1 } {
  if (node.border === undefined) return {};
  if (node.border !== 0 && node.border !== 1) return invalid();
  return { border: node.border };
}
function section(value: unknown): RichTextBlockElement {
  const node = object(value);
  switch (node.type) {
    case "rich_text_section":
      return { type: "rich_text_section", elements: array(node.elements).map(inline) };
    case "rich_text_quote":
      return {
        type: "rich_text_quote",
        elements: array(node.elements).map(inline),
        ...border(node),
      };
    case "rich_text_preformatted": {
      const elements = array(node.elements).map(inline);
      if (
        !elements.every(
          (element): element is Extract<RichTextElement, { type: "text" | "link" }> =>
            element.type === "text" || element.type === "link",
        )
      )
        return invalid();
      return { type: "rich_text_preformatted", elements, ...border(node) };
    }
    case "rich_text_list": {
      if (node.style !== "bullet" && node.style !== "ordered") return invalid();
      const elements = array(node.elements).map((value) => {
        if (object(value).type !== "rich_text_section") return invalid();
        const result = section(value);
        if (result.type !== "rich_text_section") return invalid();
        return result;
      });
      if (
        node.indent !== undefined &&
        (!Number.isInteger(node.indent) || Number(node.indent) < 0 || Number(node.indent) > 8)
      )
        return invalid();
      if (
        node.offset !== undefined &&
        (!Number.isSafeInteger(node.offset) || Number(node.offset) < 0)
      )
        return invalid();
      return {
        type: "rich_text_list",
        style: node.style,
        elements,
        ...border(node),
        ...(node.indent === undefined ? {} : { indent: Number(node.indent) }),
        ...(node.offset === undefined ? {} : { offset: Number(node.offset) }),
      };
    }
    default:
      return invalid();
  }
}
function inlineText(element: RichTextElement): string {
  switch (element.type) {
    case "text":
      return element.text;
    case "link":
      return element.text ?? element.url;
    case "emoji":
      return element.unicode
        ? String.fromCodePoint(...element.unicode.split("-").map((part) => parseInt(part, 16)))
        : `:${element.name}:`;
    case "channel":
      return `#${element.channel_id}`;
    default:
      return invalid();
  }
}
function visible(element: RichTextBlockElement): string {
  if (element.type === "rich_text_list") {
    const offset = (element as typeof element & { offset?: number }).offset ?? 0;
    return element.elements
      .map(
        (item, index) =>
          `${"  ".repeat(element.indent ?? 0)}${element.style === "bullet" ? "•" : `${offset + index + 1}.`} ${visible(item)}`,
      )
      .join("\n");
  }
  return element.elements.map(inlineText).join("");
}

export function contentFromBlocks(value: unknown): Content {
  boundedJSON(value);
  const blocks = Array.isArray(value) ? array(value) : [value];
  const elements = blocks.flatMap((value) => {
    const block = object(value);
    if (block.type !== "rich_text") return invalid();
    return array(block.elements).map(section);
  });
  const block: RichTextBlock = { type: "rich_text", elements };
  const text = elements.map(visible).join("\n");
  if (!text.trim() || text.length > MAX_TEXT)
    throw new Error(`Content must contain 1–${MAX_TEXT} visible characters`);
  boundedJSON(block);
  return { block, text };
}

const decode = (text: string) =>
  text.replace(
    /&(?:amp|lt|gt);/g,
    (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">" })[entity]!,
  );

export function contentFromText(text: string): Content {
  string(text);
  boundedJSON(text);
  const elements: RichTextElement[] = [];
  const append = (value: string) => {
    if (!value) return;
    const last = elements.at(-1);
    if (last?.type === "text") last.text += value;
    else elements.push({ type: "text", text: value });
  };
  const tokens = /<([^<>]+)>|:([a-zA-Z0-9_+-]+):|(?:https?:\/\/|mailto:)[^\s<>]+/g;
  let cursor = 0;
  for (const match of text.matchAll(tokens)) {
    append(decode(text.slice(cursor, match.index)));
    const raw = match[0];
    if (match[1] !== undefined) {
      const [target = "", ...labelParts] = match[1].split("|");
      const label = labelParts.length ? decode(labelParts.join("|")) : undefined;
      const url = decode(target);
      if (safeURL(url))
        elements.push({ type: "link", url, ...(label === undefined ? {} : { text: label }) });
      else if (/^#C[A-Z0-9]+$/.test(target))
        elements.push({ type: "channel", channel_id: target.slice(1) });
      else if (/^@[UW][A-Z0-9]+$/.test(target)) append(target);
      else if (/^!(here|channel|everyone)$/.test(target)) append(`@${target.slice(1)}`);
      else if (/^!subteam\^S[A-Z0-9]+$/.test(target)) append(`@${target.slice(9)}`);
      else append(decode(raw));
    } else if (match[2] !== undefined) elements.push({ type: "emoji", name: match[2] });
    else {
      const url = decode(raw.replace(/[.,!?;:)]+$/, ""));
      if (safeURL(url)) {
        elements.push({ type: "link", url });
        append(raw.slice(raw.replace(/[.,!?;:)]+$/, "").length));
      } else append(decode(raw));
    }
    cursor = match.index + raw.length;
  }
  append(decode(text.slice(cursor)));
  return contentFromBlocks({
    type: "rich_text",
    elements: [{ type: "rich_text_section", elements }],
  });
}

export function inputContent(state: unknown): Content {
  const input = object(state);
  if (input.rich_text_value !== undefined && input.rich_text_value !== null)
    return contentFromBlocks(input.rich_text_value);
  return contentFromText(string(input.value));
}

export function storedContent(text: string, block: unknown): Content {
  return block == null ? contentFromText(text) : contentFromBlocks(block);
}

function splitInlines(elements: RichTextElement[], limit: number): RichTextElement[][] {
  const chunks: RichTextElement[][] = [[]];
  let length = 0;
  for (const element of elements) {
    let remaining = inlineText(element);
    if (element.type !== "text" && element.type !== "link") {
      if (remaining.length > limit) return invalid();
      if (length + remaining.length > limit) {
        chunks.push([]);
        length = 0;
      }
      chunks.at(-1)!.push(element);
      length += remaining.length;
      continue;
    }
    do {
      if (length === limit) {
        chunks.push([]);
        length = 0;
      }
      let end = Math.min(remaining.length, limit - length);
      if (
        end < remaining.length &&
        /[\uD800-\uDBFF]/u.test(remaining[end - 1] ?? "") &&
        /[\uDC00-\uDFFF]/u.test(remaining[end] ?? "")
      )
        end--;
      if (!end && remaining.length) {
        chunks.push([]);
        length = 0;
        continue;
      }
      chunks.at(-1)!.push({ ...element, text: remaining.slice(0, end) });
      length += end;
      remaining = remaining.slice(end);
    } while (remaining.length);
  }
  return chunks;
}

function splitElement(element: RichTextBlockElement): RichTextBlockElement[] {
  if (visible(element).length <= MAX_BLOCK_TEXT) return [element];
  if (element.type === "rich_text_list") {
    const offset = (element as typeof element & { offset?: number }).offset ?? 0;
    return element.elements.flatMap((item, index) => {
      const marker = `${"  ".repeat(element.indent ?? 0)}${element.style === "bullet" ? "•" : `${offset + index + 1}.`} `;
      return splitInlines(item.elements, MAX_BLOCK_TEXT - marker.length).map((elements) => ({
        ...element,
        ...(element.style === "ordered" ? { offset: offset + index } : {}),
        elements: [{ ...item, elements }],
      }));
    });
  }
  return splitInlines(element.elements, MAX_BLOCK_TEXT).map((elements) =>
    section({
      ...element,
      elements,
    }),
  );
}

export function contentBlocks(
  content: Content,
  heading?: string,
  inlineHeading = false,
): RichTextBlock[] {
  const { block } = contentFromBlocks(content.block);
  if (heading !== undefined) {
    if (typeof heading !== "string" || !heading.trim() || heading.length > MAX_BLOCK_TEXT)
      return invalid();
    const prefix: RichTextElement[] = [{ type: "text", text: heading, style: { bold: true } }];
    if (inlineHeading) prefix.push({ type: "text", text: ": " });
    const first = block.elements[0];
    if (inlineHeading && first?.type === "rich_text_section") first.elements.unshift(...prefix);
    else block.elements.unshift({ type: "rich_text_section", elements: prefix });
  }
  boundedJSON(block);
  const blocks: RichTextBlock[] = [];
  let length = 0;
  for (const element of block.elements.flatMap(splitElement)) {
    const size = visible(element).length;
    if (!blocks.length || length + 1 + size > MAX_BLOCK_TEXT) {
      blocks.push({ type: "rich_text", elements: [] });
      length = 0;
    }
    const current = blocks.at(-1)!;
    length += (current.elements.length ? 1 : 0) + size;
    current.elements.push(element);
  }
  return blocks;
}
