import { describe, expect, test } from "bun:test";
import { contentBlocks, contentFromText } from "./content.js";
import { attributed, attributedTo } from "./demo.js";

describe("demo attribution", () => {
  test("names the author above the content", () => {
    const content = attributed(contentFromText("hello *world*"), "U123ABC", "jer");
    expect(content.text).toBe("from jer (demo)\nhello world");
    expect(content.block.elements[0]).toEqual({
      type: "rich_text_section",
      elements: [
        { type: "text", text: "from " },
        {
          type: "link",
          url: "https://app.slack.com/team/U123ABC",
          text: "jer",
          style: { bold: true },
        },
        { type: "text", text: " (demo)", style: { italic: true } },
      ],
    });
  });

  test("survives being published with the inline id heading", () => {
    const [block] = contentBlocks(attributed(contentFromText("hi"), "U1", "jer"), "42", true);
    expect(block!.elements[0]).toMatchObject({
      elements: [{ text: "42" }, { text: ": " }, { text: "from " }, { text: "jer" }, {}],
    });
  });

  test("can't be smuggled past the length limit", () => {
    expect(() => attributed(contentFromText("a".repeat(12_000)), "U1", "jer")).toThrow();
  });

  test("falls back to the user id when the lookup fails", async () => {
    const client = {
      users: {
        info: async () => {
          throw new Error("missing_scope");
        },
      },
    } as unknown as Parameters<typeof attributedTo>[0];
    const content = await attributedTo(client, "U999", contentFromText("hi"));
    expect(content.text).toBe("from U999 (demo)\nhi");
  });

  test("prefers the display name", async () => {
    const client = {
      users: {
        info: async () => ({ user: { real_name: "Real Name", profile: { display_name: "disp" } } }),
      },
    } as unknown as Parameters<typeof attributedTo>[0];
    expect((await attributedTo(client, "U1", contentFromText("hi"))).text).toStartWith(
      "from disp ",
    );
  });
});
