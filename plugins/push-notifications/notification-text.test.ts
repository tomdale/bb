import { describe, expect, it } from "vitest";
import { notificationPreviewText } from "./notification-text.js";

function preview(lines: readonly string[]): Promise<string> {
  return notificationPreviewText(lines.join("\n"), async () => null);
}

describe("notificationPreviewText with container blocks", () => {
  it.each([
    [
      "a combined review block previews its headline",
      [
        ':::reply{state="review"}',
        "# Fixed the percent coupon math",
        "- [x] `apply_percent_coupon` applies a percentage, not cents",
        "- [x] Committed `a1b2c3d` locally; nothing pushed",
        "",
        "### Checked",
        "Ran `python3 -m unittest` in the repo: 5 of 5 pass.",
        ":::",
      ],
      "Fixed the percent coupon math",
    ],
    [
      "a complete block with results previews its headline",
      [
        ':::reply{state="complete"}',
        "# Added the count_items helper",
        "- [x] `count_items()` counts items in nested carts",
        "- [ ] Push the commit",
        "",
        "### Checked",
        "Ran the tests: 6 of 6 pass.",
        ":::",
      ],
      "Added the count_items helper",
    ],
    [
      "a short-answer block previews its only line",
      [':::reply{state="complete"}', "# Python 3.9 or newer", ":::"],
      "Python 3.9 or newer",
    ],
    [
      "a block with no state previews its prose without the markers",
      [":::reply", "The coupon code can be applied twice in one cart.", ":::"],
      "The coupon code can be applied twice in one cart.",
    ],
    [
      "a plain sentence before a block wins over the block",
      [
        "Here is where things stand.",
        ':::reply{state="complete"}',
        "# Renamed the cart helpers",
        ":::",
      ],
      "Here is where things stand.",
    ],
    [
      "a longer marker is skipped, including an inner closer in a fence",
      [
        '::::reply{state="complete"}',
        "# Documented the closer",
        "```markdown",
        ":::",
        "```",
        "::::",
      ],
      "Documented the closer",
    ],
    [
      "a block whose first heading is a section label previews its prose",
      [
        ':::reply{state="complete"}',
        "### Checked",
        "Ran the tests locally: 5 of 5 pass.",
        ":::",
      ],
      "Ran the tests locally: 5 of 5 pass.",
    ],
    [
      "task-list markers are stripped",
      [':::reply{state="complete"}', "- [x] Pushed the fix", ":::"],
      "Pushed the fix",
    ],
    [
      "leaf directives are still skipped",
      [
        '::page{id="2d98aecf" version="e4d24dd2"}',
        "",
        ":::reply",
        '::inline-vis{file="chart.html"}',
        "Pick one icon and press Ship.",
        ":::",
      ],
      "Pick one icon and press Ship.",
    ],
  ])("%s", async (_name, lines, expected) => {
    expect(await preview(lines)).toBe(expected);
  });
});

describe("notificationPreviewText headings", () => {
  it("prefers the first prose paragraph over a leading heading", async () => {
    expect(
      await preview([
        "# Release notes",
        "",
        "Shipped the SDK bump and the docs.",
      ]),
    ).toBe("Shipped the SDK bump and the docs.");
  });

  it("falls back to the first heading when a message has no prose", async () => {
    expect(await preview(["# Python 3.9 or newer"])).toBe(
      "Python 3.9 or newer",
    );
    expect(await preview(['::page{id="2d98aecf"}'])).toBe("");
  });
});
