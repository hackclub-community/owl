import { describe, expect, test } from "bun:test";
import type {
  RichTextBlock,
  RichTextBlockElement,
  RichTextElement,
  RichTextSection,
} from "@slack/web-api";
import {
  MAX_CONTENT_BYTES,
  MAX_BLOCK_TEXT,
  MAX_TEXT,
  contentBlocks,
  contentFromBlocks,
  contentFromText,
  inputContent,
  storedContent,
} from "./content.js";

const text = (value: string) => ({ type: "text" as const, text: value });

function section(elements: RichTextElement[]): RichTextSection;
function section<const T extends unknown[]>(
  elements: T,
): { type: "rich_text_section"; elements: T };
function section(elements: unknown[]) {
  return { type: "rich_text_section" as const, elements };
}
function rich(...elements: RichTextBlockElement[]): RichTextBlock;
function rich<const T extends unknown[]>(...elements: T): { type: "rich_text"; elements: T };
function rich(...elements: unknown[]) {
  return { type: "rich_text" as const, elements };
}
function inlines(...elements: RichTextElement[]): RichTextBlock;
function inlines<const T extends unknown[]>(
  ...elements: T
): {
  type: "rich_text";
  elements: [{ type: "rich_text_section"; elements: T }];
};
function inlines(...elements: unknown[]): { type: "rich_text"; elements: unknown[] } {
  return rich(section(elements));
}
const invalid = /invalid or unsupported rich-text content/i;
const byteError = "Content JSON must not exceed 48KB";

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

describe("content boundaries", () => {
  test("accepts one character and the exact visible-text limit", () => {
    expect(contentFromText("a").text).toBe("a");
    expect(contentFromText("a".repeat(MAX_TEXT)).text).toHaveLength(MAX_TEXT);
    expect(contentFromBlocks(inlines(text("a".repeat(MAX_TEXT)))).text).toHaveLength(MAX_TEXT);
  });

  test.each(["", " \n\t ", "a".repeat(MAX_TEXT + 1)])(
    "rejects empty/oversized text (%#)",
    (value) => {
      expect(() => contentFromText(value)).toThrow();
      expect(() => contentFromBlocks(inlines(text(value)))).toThrow();
    },
  );

  test("counts section separators, list markers and indentation toward the limit", () => {
    expect(() =>
      contentFromBlocks(rich(section([text("a".repeat(MAX_TEXT))]), section([text("b")]))),
    ).toThrow();
    expect(() =>
      contentFromBlocks(
        rich({
          type: "rich_text_list",
          style: "bullet",
          indent: 8,
          elements: [section([text("a".repeat(MAX_TEXT - 17))])],
        }),
      ),
    ).toThrow();
  });

  test("measures JSON bytes, accepts exactly 48KB, and rejects one byte more", () => {
    const value = { ...inlines(text("ok")), ignored: "" };
    const overhead = Buffer.byteLength(JSON.stringify(value));
    value.ignored = "é".repeat(Math.floor((MAX_CONTENT_BYTES - overhead) / 2));
    value.ignored += "a".repeat(MAX_CONTENT_BYTES - Buffer.byteLength(JSON.stringify(value)));
    expect(Buffer.byteLength(JSON.stringify(value))).toBe(MAX_CONTENT_BYTES);
    expect(contentFromBlocks(value).text).toBe("ok");
    value.ignored += "a";
    expect(() => contentFromBlocks(value)).toThrow(byteError);
    expect(() => contentFromText("é".repeat(MAX_CONTENT_BYTES / 2))).toThrow(byteError);
  });

  test("also bounds normalized output when generated message URLs expand input", () => {
    const mention = {
      type: "message_mention",
      channel_id: `C${"A".repeat(100)}`,
      message_ts: "123.123456",
      thread_ts: "122.654321",
      text: "x",
    };
    const value = inlines(...Array.from({ length: 200 }, () => ({ ...mention })));
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(MAX_CONTENT_BYTES);
    expect(() => contentFromBlocks(value)).toThrow(byteError);
  });
});

describe("supported rich text", () => {
  test("preserves supported styles, sections, quotes, preformatted text and lists", () => {
    const style = { bold: true, italic: true, strike: false, code: true, underline: true };
    const block = rich(
      section([{ ...text("styled"), style: { ...style, unknown: true } }]),
      { type: "rich_text_quote", border: 1, elements: [text("quote")] },
      {
        type: "rich_text_preformatted",
        border: 0,
        elements: [text("code"), { type: "link", url: "https://example.com", text: "link" }],
      },
      {
        type: "rich_text_list",
        style: "bullet",
        indent: 1,
        border: 0,
        elements: [section([text("bullet")])],
      },
      {
        type: "rich_text_list",
        style: "ordered",
        indent: 0,
        offset: 2,
        border: 1,
        elements: [section([text("first")]), section([text("second")])],
      },
    );
    const result = contentFromBlocks(block);
    expect(result.text).toBe("styled\nquote\ncodelink\n  • bullet\n3. first\n4. second");
    expect<unknown>(result.block).toEqual({
      ...block,
      elements: [section([{ ...text("styled"), style }]), ...block.elements.slice(1)],
    });
  });

  test("supports links, channel references, named emoji and Unicode emoji", () => {
    const block = inlines(
      { type: "link", url: "https://example.com" },
      text(" "),
      { type: "link", url: "http://example.com", text: "site", style: { bold: true } },
      text(" "),
      { type: "link", url: "mailto:test@example.com", text: "email" },
      text(" "),
      { type: "channel", channel_id: "G123" },
      text(" "),
      { type: "emoji", name: "+1" },
      text(" "),
      { type: "emoji", name: "wave", unicode: "1f44b-1f3fd" },
    );
    expect(contentFromBlocks(block)).toEqual({
      block,
      text: "https://example.com site email #G123 :+1: 👋🏽",
    });
  });

  test("flattens multiple input blocks and strips unknown metadata", () => {
    expect(
      contentFromBlocks([
        { ...inlines({ ...text("first"), unknown: true }), block_id: "ignored" },
        inlines(text("second")),
      ]),
    ).toEqual({
      block: rich(section([text("first")]), section([text("second")])),
      text: "first\nsecond",
    });
  });
});

describe("sanitization and text parsing", () => {
  test("turns user, usergroup and broadcast mentions into non-pinging text", () => {
    const result = contentFromBlocks(
      inlines(
        { type: "user", user_id: "U123", style: { bold: true } },
        { type: "user", user_id: "W123" },
        { type: "usergroup", usergroup_id: "S123" },
        ...["here", "channel", "everyone"].map((range) => ({ type: "broadcast", range })),
      ),
    );
    expect(result).toEqual({
      block: inlines(
        { ...text("@U123"), style: { bold: true } },
        text("@W123"),
        text("@S123"),
        text("@here"),
        text("@channel"),
        text("@everyone"),
      ),
      text: "@U123@W123@S123@here@channel@everyone",
    });
  });

  test("converts message mentions to links with optional thread context", () => {
    expect(
      contentFromBlocks(
        inlines({
          type: "message_mention",
          channel_id: "C123",
          message_ts: "123.123456",
          thread_ts: "122.654321",
          text: "message",
          style: { italic: true },
        }),
      ).block,
    ).toEqual(
      inlines({
        type: "link",
        url: "https://app.slack.com/archives/C123/p123123456?thread_ts=122.654321&cid=C123",
        text: "message",
        style: { italic: true },
      }),
    );
    expect(
      contentFromBlocks(
        inlines({ type: "message_mention", channel_id: "G123", message_ts: "123.123456" }),
      ).text,
    ).toBe("https://app.slack.com/archives/G123/p123123456");
    expect(
      contentFromBlocks(
        inlines({
          type: "message_mention",
          channel_id: "C123",
          message_ts: "123.123456",
          url: "javascript:alert(1)",
          text: "message",
        }),
      ).block,
    ).toEqual(inlines(text("message")));
  });

  test.each([
    "javascript:alert(1)",
    "data:text/html,test",
    "ftp://example.com",
    "//example.com",
    "https://user:pass@example.com",
    "https://example.com/a b",
    "https://example.com/\npath",
    "https://example.com/\u0000",
    "https://example.com/\u007f",
    "https://example.com/<tag>",
    "https://example.com/\\path",
    "https://",
    "mailto:",
  ])("unsafe URL %j becomes plain text, never a link", (url) => {
    expect(
      contentFromBlocks(inlines({ type: "link", url, text: "label", style: { bold: true } })).block,
    ).toEqual(inlines({ ...text("label"), style: { bold: true } }));
    expect(contentFromBlocks(inlines({ type: "link", url })).block).toEqual(inlines(text(url)));
  });

  test("parses Slack text syntax, entities, emoji, safe URLs and punctuation", () => {
    const result = contentFromText(
      "&lt;ok&gt; &amp; <https://example.com?a=1&amp;b=2|A &amp; B> :wave: https://example.com/path.,!?;:)",
    );
    expect(result.block).toEqual(
      inlines(
        text("<ok> & "),
        { type: "link", url: "https://example.com?a=1&b=2", text: "A & B" },
        text(" "),
        { type: "emoji", name: "wave" },
        text(" "),
        { type: "link", url: "https://example.com/path" },
        text(".,!?;:)"),
      ),
    );
    expect(result.text).toBe("<ok> & A & B :wave: https://example.com/path.,!?;:)");
  });

  test("sanitizes text mentions and preserves unsupported markup as plain text", () => {
    const result = contentFromText(
      "<@U123> <@W123> <!subteam^S123|team> <!here> <!channel> <!everyone> <#C123|general> <javascript:alert(1)|bad> https://user:pass@example.com",
    );
    expect(result.text).toBe(
      "@U123 @W123 @S123 @here @channel @everyone #C123 <javascript:alert(1)|bad> https://user:pass@example.com",
    );
    expect(result.block).toEqual(
      inlines(
        text("@U123 @W123 @S123 @here @channel @everyone "),
        { type: "channel", channel_id: "C123" },
        text(" <javascript:alert(1)|bad> https://user:pass@example.com"),
      ),
    );
  });
});

describe("malformed content", () => {
  test.each(
    [
      null,
      undefined,
      false,
      67,
      "text",
      [],
      {},
      { type: "section", elements: [text("x")] },
      rich(),
      rich(null),
      rich({ type: "unknown" }),
      rich(section([])),
      rich(section([null])),
      inlines({ type: "text", text: 67 }),
      inlines({ type: "image", url: "https://example.com" }),
      inlines({ ...text("x"), style: [] }),
      inlines({ ...text("x"), style: { bold: "true" } }),
      inlines({ type: "link", url: 67 }),
      inlines({ type: "link", url: "https://example.com", text: null }),
      inlines({ type: "user", user_id: "U" }),
      inlines({ type: "user", user_id: "u123" }),
      inlines({ type: "channel", channel_id: "U123" }),
      inlines({ type: "usergroup", usergroup_id: "C123" }),
      inlines({ type: "broadcast", range: "all" }),
      inlines({ type: "message_mention", channel_id: "C123", message_ts: "123.12" }),
      inlines({
        type: "message_mention",
        channel_id: "C123",
        message_ts: "123.123456",
        thread_ts: "bad",
      }),
      inlines({ type: "emoji", name: "bad name" }),
      inlines({ type: "emoji", name: "ok", unicode: "xyz" }),
      ...["110000", "d800", "001f", "007f"].map((unicode) =>
        inlines({ type: "emoji", name: "ok", unicode }),
      ),
      rich({ type: "rich_text_quote", border: 2, elements: [text("x")] }),
      rich({ type: "rich_text_preformatted", elements: [{ type: "emoji", name: "wave" }] }),
      rich({ type: "rich_text_list", style: "unknown", elements: [section([text("x")])] }),
      rich({
        type: "rich_text_list",
        style: "bullet",
        elements: [{ type: "rich_text_quote", elements: [text("x")] }],
      }),
      ...[-1, 9, 0.5, "1"].map((indent) =>
        rich({ type: "rich_text_list", style: "bullet", indent, elements: [section([text("x")])] }),
      ),
      ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map((offset) =>
        rich({
          type: "rich_text_list",
          style: "ordered",
          offset,
          elements: [section([text("x")])],
        }),
      ),
    ].map((value) => [value]),
  )("rejects malformed structure %#", (value) => {
    expect(() => contentFromBlocks(value)).toThrow();
  });

  test("rejects unserializable content without leaking serialization errors", () => {
    const cyclic: Record<string, unknown> = inlines(text("x"));
    cyclic.self = cyclic;
    expect(() => contentFromBlocks(cyclic)).toThrow(invalid);
    expect(() => contentFromBlocks({ ...inlines(text("x")), extra: 1n })).toThrow(invalid);
  });
});

describe("input, storage and headings", () => {
  test("prefers rich-text input and falls back to legacy text only when absent/null", () => {
    const expected = contentFromText("rich");
    expect(inputContent({ rich_text_value: expected.block, value: "ignored" })).toEqual(expected);
    expect(inputContent({ value: "legacy" })).toEqual(contentFromText("legacy"));
    expect(inputContent({ rich_text_value: null, value: "legacy" })).toEqual(
      contentFromText("legacy"),
    );
    expect(() => inputContent({ rich_text_value: {}, value: "no fallback" })).toThrow();
    for (const value of [null, [], {}, { value: 67 }]) expect(() => inputContent(value)).toThrow();
  });

  test("roundtrips sanitized blocks through JSON storage and ignores stale stored text", () => {
    const original = inputContent({
      rich_text_value: inlines({ type: "user", user_id: "U123" }, text(" hi "), {
        type: "link",
        url: "https://example.com",
        text: "site",
      }),
    });
    const saved = JSON.parse(JSON.stringify(original.block));
    expect(storedContent("stale", saved)).toEqual(original);
    expect(inputContent({ rich_text_value: saved })).toEqual(original);
    expect(storedContent("legacy :wave:", null)).toEqual(contentFromText("legacy :wave:"));
    expect(storedContent("legacy", undefined)).toEqual(contentFromText("legacy"));
    expect(() => storedContent("no fallback", {})).toThrow();
  });

  test("clones frozen source content for standalone and inline headings", () => {
    const content = freeze(contentFromText("body"));
    const before = JSON.stringify(content);
    expect(contentBlocks(content)).toEqual([content.block]);
    expect(contentBlocks(content)[0]).not.toBe(content.block);
    expect(contentBlocks(content, "Title")).toEqual([
      rich(section([{ ...text("Title"), style: { bold: true } }]), section([text("body")])),
    ]);
    expect(contentBlocks(content, "Title", true)).toEqual([
      inlines({ ...text("Title"), style: { bold: true } }, text(": "), text("body")),
    ]);
    expect(JSON.stringify(content)).toBe(before);
  });

  test("inline headings use a separate section before lists, without mutation", () => {
    const content = freeze(
      contentFromBlocks(
        rich({ type: "rich_text_list", style: "bullet", elements: [section([text("item")])] }),
      ),
    );
    expect(contentBlocks(content, "Title", true)).toEqual([
      rich(
        section([{ ...text("Title"), style: { bold: true } }, text(": ")]),
        ...content.block.elements,
      ),
    ]);
    expect(content.block.elements).toHaveLength(1);
  });

  test("validates headings and bounds the final block size", () => {
    const content = contentFromText("body");
    for (const heading of ["", " \t ", "a".repeat(MAX_BLOCK_TEXT + 1)]) {
      expect(() => contentBlocks(content, heading)).toThrow(invalid);
    }
    expect(contentBlocks(content, "a".repeat(MAX_BLOCK_TEXT))).toHaveLength(2);
    const large = contentFromBlocks(
      inlines(text("x"), ...Array.from({ length: 1800 }, () => text(""))),
    );
    expect(() => contentBlocks(large, "a".repeat(MAX_BLOCK_TEXT))).toThrow(byteError);
  });
});
