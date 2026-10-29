import { describe, expect, test } from "bun:test";
import { contentBlocks, contentFromText } from "./content.js";
import { attributed, attributedTo, byline } from "./demo.js";

type Client = Parameters<typeof attributedTo>[0];
const named = (display_name: string, real_name = "Real Name") =>
  ({
    users: { info: async () => ({ user: { real_name, profile: { display_name } } }) },
  }) as unknown as Client;
const failing = {
  users: {
    info: async () => {
      throw new Error("missing_scope");
    },
  },
} as unknown as Client;

describe("demo attribution", () => {
  test("signs the content with a profile link", () => {
    const content = attributed(contentFromText("hello *world*"), "U123ABC", "jer");
    expect(content.text).toBe("hello world\n— jer");
    expect(content.block.elements.at(-1)).toEqual({
      type: "rich_text_section",
      elements: [
        { type: "text", text: "— ", style: { italic: true } },
        {
          type: "link",
          url: "https://app.slack.com/team/U123ABC",
          text: "jer",
          style: { italic: true },
        },
      ],
    });
  });

  test("leaves the id heading where Taut expects it", () => {
    const [block] = contentBlocks(attributed(contentFromText("hi"), "U1", "jer"), "42", true);
    expect(block!.elements[0]).toMatchObject({
      elements: [{ text: "42" }, { text: ": " }, { text: "hi" }],
    });
  });

  test("can't be smuggled past the length limit", () => {
    expect(() => attributed(contentFromText("a".repeat(12_000)), "U1", "jer")).toThrow();
  });

  test("falls back to the user id when the lookup fails", async () => {
    const content = await attributedTo(failing, "U999", contentFromText("hi"));
    expect(content.text).toBe("hi\n— U999");
  });

  test("prefers the display name", async () => {
    expect((await attributedTo(named("disp"), "U1", contentFromText("hi"))).text).toEndWith(
      "— disp",
    );
    expect((await attributedTo(named(""), "U1", contentFromText("hi"))).text).toEndWith(
      "— Real Name",
    );
  });
});

describe("demo bylines", () => {
  test("names whoever acted as a link", async () => {
    expect(await byline(named("rev"), "U42", true)).toBe(
      " by <https://app.slack.com/team/U42|rev>",
    );
  });

  test("can't break out of the link", async () => {
    expect(await byline(named("<!channel>|x & y"), "U42", true)).toBe(
      " by <https://app.slack.com/team/U42|&lt;!channel&gt;¦x &amp; y>",
    );
  });

  test("still names them by id when the lookup fails", async () => {
    expect(await byline(failing, "U42", true)).toBe(" by <https://app.slack.com/team/U42|U42>");
  });

  test("says nothing and looks nobody up outside a demo", async () => {
    let called = false;
    const client = {
      users: {
        info: async () => {
          called = true;
          return {};
        },
      },
    } as unknown as Client;
    expect(await byline(client, "U42", false)).toBe("");
    expect(called).toBe(false);
  });
});
