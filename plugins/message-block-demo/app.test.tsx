// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import type { Root } from "mdast";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { demoCardCodec } from "./card";

const app = await loadPluginApp(() => import("./app"));

afterEach(cleanup);

const SOURCE = "A lead.\n\n### Done\nTests pass.\n\n### Next\nShip it.";

const TREE: Root = {
  type: "root",
  children: [
    {
      type: "paragraph",
      children: [{ type: "text", value: "A lead." }],
      position: {
        start: { line: 1, column: 1, offset: 0 },
        end: { line: 1, column: 8, offset: 7 },
      },
    },
    {
      type: "heading",
      depth: 3,
      children: [{ type: "text", value: "Done" }],
      position: {
        start: { line: 3, column: 1, offset: 9 },
        end: { line: 3, column: 9, offset: 17 },
      },
    },
    {
      type: "paragraph",
      children: [{ type: "text", value: "Tests pass." }],
      position: {
        start: { line: 4, column: 1, offset: 18 },
        end: { line: 4, column: 12, offset: 29 },
      },
    },
    {
      type: "heading",
      depth: 3,
      children: [{ type: "text", value: "Next" }],
      position: {
        start: { line: 6, column: 1, offset: 31 },
        end: { line: 6, column: 9, offset: 39 },
      },
    },
    {
      type: "paragraph",
      children: [{ type: "text", value: "Ship it." }],
      position: {
        start: { line: 7, column: 1, offset: 40 },
        end: { line: 7, column: 9, offset: 48 },
      },
    },
  ],
};

const MESSAGE = {
  id: "msg_1",
  threadId: "thr_1",
  turnId: "turn_1",
  projectId: "proj_1",
};

describe("message block demo", () => {
  it("registers the demo-card block", () => {
    expect(app.messageBlocks).toHaveLength(1);
    expect(app.messageBlocks[0]).toMatchObject({
      name: "demo-card",
      versions: [1],
    });
  });

  it("groups the tree by heading and slices each section's markdown", () => {
    const result = demoCardCodec.parse(
      { attributes: { v: "1" }, source: SOURCE, tree: TREE },
      { status: "closed", version: 1 },
    );
    expect(result).toEqual({
      ok: true,
      data: {
        lead: "A lead.",
        sections: [
          { title: "Done", markdown: "Tests pass." },
          { title: "Next", markdown: "Ship it." },
        ],
      },
    });
    expect(result.ok ? demoCardCodec.toText(result.data) : "").toBe(
      "A lead.\n\nDone\nTests pass.\n\nNext\nShip it.",
    );
  });

  it("accepts a partial block while it streams and rejects a finished one with no heading", () => {
    const lead: Root = { type: "root", children: TREE.children.slice(0, 1) };
    expect(
      demoCardCodec.parse(
        { attributes: {}, source: "A lead.", tree: lead },
        { status: "streaming", version: 1 },
      ).ok,
    ).toBe(true);
    expect(
      demoCardCodec.parse(
        { attributes: {}, source: "A lead.", tree: lead },
        { status: "unclosed", version: 1 },
      ),
    ).toEqual({ ok: false, error: "a demo card needs at least one heading" });
  });

  it("draws the sections, the literal block on request, and a placeholder while data is missing", async () => {
    const block = app.messageBlocks[0]!;
    const drawn = renderSlot(block, {
      data: {
        lead: "A lead.",
        sections: [{ title: "Done", markdown: "Tests pass." }],
      },
      error: null,
      index: 0,
      message: MESSAGE,
      source: `:::demo-card\n${SOURCE}\n:::`,
      status: "closed",
      Original: () => <p>literal block</p>,
    });
    expect(await drawn.findByText("Done")).toBeTruthy();
    expect(drawn.getByText("Complete")).toBeTruthy();
    fireEvent.click(drawn.getByRole("button", { name: "Source" }));
    expect(drawn.getByText("literal block")).toBeTruthy();
    cleanup();

    const waiting = renderSlot(block, {
      data: null,
      error: "not yet",
      index: 0,
      message: MESSAGE,
      source: ":::demo-card",
      status: "streaming",
      Original: () => <p>literal block</p>,
    });
    expect(await waiting.findByText("Waiting for content…")).toBeTruthy();
    expect(waiting.getByText("Writing…")).toBeTruthy();
  });
});
