// @vitest-environment jsdom

import { useEffect, useState, type ComponentType } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExperimentalCodeFenceRendererProps,
  ExperimentalMessageBlockProps,
  ExperimentalMessageBlockRegistration,
  JsonValue,
} from "@get-bb/plugin-sdk";
import { resetAllCrashedPluginSlotsForTest } from "@/components/plugin/PluginSlotMount";
import { ConversationMessageContent } from "@/components/thread/timeline/ConversationMessageContent";
import { ThreadTimelineRows } from "@/components/thread/timeline/ThreadTimelineRows";
import { RouteNavigationProvider } from "@/components/ui/app-route-anchor";
import type { PluginMessageBlockSlot } from "@/lib/plugin-slots";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import {
  conversationRow,
  delegationRow,
} from "@/test/fixtures/thread-timeline-rows";
import { MarkdownPreview } from "./markdown-preview";
import {
  buildMessageDirectiveRegistry,
  MessageDirectiveRegistryProvider,
} from "./markdown-message-directives";
import {
  MESSAGE_BLOCK_FAILURE_NOTE,
  MessageBlockHost,
} from "./markdown-message-blocks";
import {
  buildCodeFenceRendererRegistry,
  CodeFenceRendererRegistryProvider,
} from "./markdown-code-fence-renderers";

const THREAD_MENTIONS = { mentions: [], preserveSoftBreaks: false };

const MESSAGE = {
  id: "msg_1",
  threadId: "thr_1",
  turnId: "turn_1",
  projectId: "proj_1",
} as const;

interface CardData {
  headings: string[];
  sliced: string[];
  status: string;
  version: number;
}

function isCardData(value: JsonValue | null): value is CardData & JsonValue {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray(value.headings)
  );
}

const parseCard: ExperimentalMessageBlockRegistration["parse"] = (
  input,
  context,
) => {
  const headings: string[] = [];
  const sliced: string[] = [];
  for (const node of input.tree.children) {
    if (node.type !== "heading") continue;
    const text = node.children
      .map((child) => (child.type === "text" ? child.value : ""))
      .join("");
    headings.push(text);
    const start = node.position?.start.offset ?? 0;
    const end = node.position?.end.offset ?? 0;
    sliced.push(input.source.slice(start, end));
  }
  if (input.attributes.fail === "yes") {
    return { ok: false, error: "asked to fail" };
  }
  return {
    ok: true,
    data: {
      headings,
      sliced,
      status: context.status,
      version: context.version,
    },
  };
};

function Card(props: ExperimentalMessageBlockProps) {
  const data = isCardData(props.data) ? props.data : null;
  return (
    <div
      data-testid="card"
      data-status={props.status}
      data-index={props.index}
      data-error={props.error ?? ""}
      data-source={props.source}
      data-message-id={props.message.id}
      data-headings={data?.headings.join("|") ?? ""}
      data-sliced={data?.sliced.join("|") ?? ""}
      data-version={data?.version ?? ""}
    />
  );
}

function blockSlot(
  overrides: Partial<PluginMessageBlockSlot> = {},
): PluginMessageBlockSlot {
  return {
    pluginId: "cards",
    generation: 1,
    name: "card",
    versions: [1],
    parse: parseCard,
    toText: () => "",
    component: Card,
    ...overrides,
  };
}

function previewElement(
  content: string,
  blocks: readonly PluginMessageBlockSlot[],
  streaming: boolean,
) {
  const registry = buildMessageDirectiveRegistry([], { blocks });
  return (
    <MessageBlockHost message={MESSAGE} textComplete={!streaming}>
      <MarkdownPreview
        allowHtml
        content={content}
        incrementalBlocks
        messageDirectives={{
          registry,
          message: MESSAGE,
          openWorkspaceFile: null,
        }}
        threadMentions={THREAD_MENTIONS}
      />
    </MessageBlockHost>
  );
}

function renderPreview(
  content: string,
  blocks: readonly PluginMessageBlockSlot[] = [blockSlot()],
  streaming = false,
) {
  return render(previewElement(content, blocks, streaming));
}

function paragraphTexts(root: ParentNode): string[] {
  return [...root.querySelectorAll("p")].map(
    (paragraph) => paragraph.textContent ?? "",
  );
}

const COMPLETE_BLOCK = [
  "Intro.",
  "",
  ':::card{v="1"}',
  "### Done",
  "Tests pass.",
  "",
  "### Next",
  "Ship it.",
  ":::",
  "",
  "Outro.",
].join("\n");

afterEach(() => {
  cleanup();
  resetAllCrashedPluginSlotsForTest();
  resetPluginSlotStoreForTest();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("message blocks in MarkdownPreview", () => {
  it("mounts a closed block with parsed data, raw source, and the message", () => {
    const { container } = renderPreview(COMPLETE_BLOCK);

    const card = screen.getByTestId("card");
    expect(card.getAttribute("data-status")).toBe("closed");
    expect(card.getAttribute("data-headings")).toBe("Done|Next");
    expect(card.getAttribute("data-sliced")).toBe("### Done|### Next");
    expect(card.getAttribute("data-version")).toBe("1");
    expect(card.getAttribute("data-index")).toBe("0");
    expect(card.getAttribute("data-message-id")).toBe("msg_1");
    expect(card.getAttribute("data-source")).toBe(
      ':::card{v="1"}\n### Done\nTests pass.\n\n### Next\nShip it.\n:::',
    );
    expect(paragraphTexts(container)).toEqual(["Intro.", "Outro."]);
  });

  it("passes partial contents with the streaming status and shows no note", () => {
    const { container } = renderPreview(
      ':::card{v="1"}\n### Done\nTests pass.\n\n### Ne',
      [blockSlot()],
      true,
    );

    const card = screen.getByTestId("card");
    expect(card.getAttribute("data-status")).toBe("streaming");
    expect(card.getAttribute("data-headings")).toBe("Done|Ne");
    expect(container.textContent).not.toContain(MESSAGE_BLOCK_FAILURE_NOTE);
  });

  it("hands a failed streaming parse to the component, then shows literal source with a note", () => {
    const content = ':::card{fail="yes"}\n### Done\n';
    const blocks = [blockSlot()];
    const { rerender, container } = renderPreview(content, blocks, true);
    expect(screen.getByTestId("card").getAttribute("data-error")).toBe(
      "asked to fail",
    );

    rerender(previewElement(content, blocks, false));
    expect(screen.queryByTestId("card")).toBeNull();
    expect(paragraphTexts(container)).toEqual([
      ':::card{fail="yes"}',
      MESSAGE_BLOCK_FAILURE_NOTE,
    ]);
    expect(container.querySelector("h3")?.textContent).toBe("Done");
  });

  it("marks a block that never closed as unclosed once the message ends", () => {
    renderPreview(":::card\n### Only\nNo closer.");
    expect(screen.getByTestId("card").getAttribute("data-status")).toBe(
      "unclosed",
    );
  });

  it("keeps blocks in lists, quotes, and code literal without a note", () => {
    const { container } = renderPreview(
      [
        "- item",
        "",
        "  :::card",
        "  ### Nested",
        "  :::",
        "",
        "> :::card",
        "> quoted",
        "> :::",
        "",
        "Inline `:::card` code.",
        "",
        "```",
        ":::card",
        "### Fenced",
        ":::",
        "```",
      ].join("\n"),
    );

    expect(screen.queryByTestId("card")).toBeNull();
    expect(container.textContent).not.toContain(MESSAGE_BLOCK_FAILURE_NOTE);
    expect(container.querySelector("li")?.textContent).toContain(":::card");
    expect(container.querySelector("blockquote")?.textContent).toContain(
      ":::card",
    );
    expect(container.querySelector("code")?.textContent).toBe(":::card");
  });

  it("mounts through the HTML sanitizer path and keeps raw HTML as html nodes", async () => {
    const parse = vi.fn(parseCard);
    const { container } = renderPreview(
      "Intro with <b>bold</b>.\n\n:::card\n### Raw <i>html</i>\n:::",
      [blockSlot({ parse })],
    );

    await waitFor(() => {
      expect(container.querySelector("b")?.textContent).toBe("bold");
    });
    expect(screen.getByTestId("card").getAttribute("data-status")).toBe(
      "closed",
    );
    const tree = parse.mock.calls.at(-1)?.[0].tree;
    const heading = tree?.children[0];
    expect(heading?.type).toBe("heading");
    expect(
      heading?.type === "heading"
        ? heading.children.some((child) => child.type === "html")
        : false,
    ).toBe(true);
  });

  it("renders literal source with a note when two plugins claim the same name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = renderPreview(":::card\n### Done\n:::", [
      blockSlot({ pluginId: "alpha" }),
      blockSlot({ pluginId: "zeta" }),
    ]);

    expect(screen.queryByTestId("card")).toBeNull();
    expect(paragraphTexts(container)).toEqual([
      ":::card",
      ":::",
      MESSAGE_BLOCK_FAILURE_NOTE,
    ]);
    expect(
      warn.mock.calls.some((call) =>
        String(call[0]).includes(
          'message block "card" claimed by multiple plugins',
        ),
      ),
    ).toBe(true);
  });

  it("isolates a crashing component and a throwing parse to their own blocks", () => {
    function Crash(): never {
      throw new Error("component boom");
    }
    const { container } = renderPreview(
      [
        ":::crash\n### One\n:::",
        ":::thrower\n### Two\n:::",
        ":::card\n### Three\n:::",
      ].join("\n\n"),
      [
        blockSlot({ name: "crash", pluginId: "crasher", component: Crash }),
        blockSlot({
          name: "thrower",
          pluginId: "thrower",
          parse: () => {
            throw new Error("parse boom");
          },
        }),
        blockSlot(),
      ],
    );

    expect(screen.getByTestId("card").getAttribute("data-headings")).toBe(
      "Three",
    );
    expect(paragraphTexts(container)).toEqual([
      ":::crash",
      ":::",
      MESSAGE_BLOCK_FAILURE_NOTE,
      ":::thrower",
      ":::",
      MESSAGE_BLOCK_FAILURE_NOTE,
    ]);
  });

  it("reads the version from v, defaults it to 1, and keeps unlisted versions literal", () => {
    const { container } = renderPreview(
      [':::card{v="2"}\n### Two\n:::', ":::card\n### Default\n:::"].join(
        "\n\n",
      ),
      [blockSlot({ versions: [1] })],
    );

    expect(screen.getByTestId("card").getAttribute("data-headings")).toBe(
      "Default",
    );
    expect(paragraphTexts(container).slice(0, 3)).toEqual([
      ':::card{v="2"}',
      ":::",
      MESSAGE_BLOCK_FAILURE_NOTE,
    ]);
  });

  it("draws at most eight blocks per message and indexes blocks by name", () => {
    const content = Array.from(
      { length: 9 },
      (_, index) =>
        `${index % 2 === 0 ? ":::card" : ":::other"}\n### B${index}\n:::`,
    ).join("\n\n");
    const { container } = renderPreview(content, [
      blockSlot(),
      blockSlot({ name: "other", pluginId: "others" }),
    ]);

    const cards = screen.getAllByTestId("card");
    expect(cards).toHaveLength(8);
    expect(
      cards.map(
        (card) =>
          `${card.getAttribute("data-headings")}:${card.getAttribute("data-index")}`,
      ),
    ).toEqual(["B0:0", "B1:0", "B2:1", "B3:1", "B4:2", "B5:2", "B6:3", "B7:3"]);
    expect(paragraphTexts(container)).toEqual([
      ":::card",
      ":::",
      MESSAGE_BLOCK_FAILURE_NOTE,
    ]);
  });

  it("keeps a block over 64 KiB literal", () => {
    const body = `${"x".repeat(70 * 1024)}\n`;
    const { container } = renderPreview(`:::card\n${body}:::`);
    expect(screen.queryByTestId("card")).toBeNull();
    expect(paragraphTexts(container).at(-1)).toBe(MESSAGE_BLOCK_FAILURE_NOTE);
  });

  it("shows literal source when the final parse runs past its 4 ms budget", () => {
    const now = vi.spyOn(performance, "now");
    let clock = 0;
    now.mockImplementation(() => {
      clock += 5;
      return clock;
    });
    const { container } = renderPreview(":::card\n### Slow\n:::");
    expect(screen.queryByTestId("card")).toBeNull();
    expect(paragraphTexts(container).at(-1)).toBe(MESSAGE_BLOCK_FAILURE_NOTE);
  });

  it("leaves names nobody registered literal with no note", () => {
    const { container } = renderPreview(":::unknown\n### Plain\n:::");
    expect(paragraphTexts(container)).toEqual([":::unknown", ":::"]);
  });
});

describe("message blocks in conversation messages", () => {
  function renderMessage(
    role: "assistant" | "user",
    text: string,
    streaming = false,
  ) {
    const registry = buildMessageDirectiveRegistry([], {
      blocks: [blockSlot()],
    });
    return render(messageElement(registry, role, text, streaming));
  }

  function messageElement(
    registry: ReturnType<typeof buildMessageDirectiveRegistry>,
    role: "assistant" | "user",
    text: string,
    streaming: boolean,
  ) {
    return (
      <MemoryRouter>
        <RouteNavigationProvider>
          <MessageDirectiveRegistryProvider registry={registry}>
            {role === "assistant" ? (
              <ConversationMessageContent
                role="assistant"
                attachments={null}
                id="msg_a"
                threadId="thr_a"
                turnId="turn_a"
                showActions={false}
                mobileActionDisplay="overflow"
                streaming={streaming}
                textComplete={!streaming}
                text={text}
                timestamp={0}
                projectId="proj_a"
              />
            ) : (
              <ConversationMessageContent
                role="user"
                attachments={null}
                initiator="user"
                mentions={[]}
                senderThreadId={null}
                senderThreadTitle={null}
                senderIsPluginSideChat={false}
                systemMessageKind="unlabeled"
                systemMessageSubject={null}
                text={text}
                timestamp={0}
                threadId="thr_a"
                turnRequest={{
                  isGrouped: false,
                  kind: "message",
                  status: "accepted",
                }}
              />
            )}
          </MessageDirectiveRegistryProvider>
        </RouteNavigationProvider>
      </MemoryRouter>
    );
  }

  it("never activates blocks in user messages", () => {
    renderMessage("user", ":::card\n### Done\n:::");
    expect(screen.queryByTestId("card")).toBeNull();
  });

  it("keeps a streaming block with blank lines whole and counts blocks across the split", () => {
    renderMessage(
      "assistant",
      [
        ":::card\n### First\n:::",
        "Between.",
        ":::card\n### Second\n\nMore text.\n\n### Third",
        "",
      ].join("\n\n"),
      true,
    );

    const cards = screen.getAllByTestId("card");
    expect(
      cards.map(
        (card) =>
          `${card.getAttribute("data-headings")}:${card.getAttribute("data-index")}:${card.getAttribute("data-status")}`,
      ),
    ).toEqual(["First:0:closed", "Second|Third:1:streaming"]);
  });

  it("mounts blocks in assistant and nested agent output from the slot store", () => {
    setPluginSlotRegistrations(
      "cards",
      makePluginRegistrationSet({
        messageBlocks: [
          {
            name: "card",
            versions: [1],
            parse: parseCard,
            toText: () => "",
            component: Card,
          },
        ],
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ThreadTimelineRows
            initialExpanded={new Set(["del_1"])}
            threadId="thr_main"
            projectId="proj_main"
            timelineRows={[
              conversationRow({
                id: "asst_1",
                role: "assistant",
                text: ":::card\n### Top\n:::",
                threadId: "thr_main",
                turnId: "turn_top",
              }),
              delegationRow({
                id: "del_1",
                status: "pending",
                durationMs: null,
                output: ":::card\n### Nested\n:::",
                threadId: "thr_main",
                turnId: "turn_del",
                childRows: [],
              }),
            ]}
            threadRuntimeDisplayStatus="active"
            workspaceRootPath={undefined}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const headings = screen
      .getAllByTestId("card")
      .map((card) => card.getAttribute("data-headings"))
      .sort();
    expect(headings).toEqual(["Nested", "Top"]);
  });
  it("keeps one component instance and its state from the opener through the closer and the finished reply", () => {
    let mounts = 0;
    function StatefulCard(props: ExperimentalMessageBlockProps) {
      const [clicks, setClicks] = useState(0);
      useEffect(() => {
        mounts += 1;
      }, []);
      return (
        <button
          type="button"
          data-testid="stateful-card"
          data-status={props.status}
          data-source={props.source}
          onClick={() => setClicks((value) => value + 1)}
        >
          clicks {clicks}
        </button>
      );
    }
    const registry = buildMessageDirectiveRegistry([], {
      blocks: [blockSlot({ component: StatefulCard })],
    });
    const element = (text: string, streaming: boolean) =>
      messageElement(registry, "assistant", text, streaming);
    const body = "Intro.\n\n:::card\n### Done\n\nTests pass.\n\n### Next";
    const view = render(element(body.slice(0, -2), true));
    fireEvent.click(screen.getByTestId("stateful-card"));
    const steps: ReadonlyArray<readonly [string, boolean, string]> = [
      [body, true, "streaming"],
      [`${body}\nShip it.\n:::\n`, true, "closed"],
      [`${body}\nShip it.\n:::`, false, "closed"],
    ];
    for (const [text, streaming, status] of steps) {
      view.rerender(element(text, streaming));
      const card = screen.getByTestId("stateful-card");
      expect(card.getAttribute("data-status")).toBe(status);
      expect(card.textContent).toBe("clicks 1");
    }
    expect(mounts).toBe(1);

    view.unmount();
    mounts = 0;
    const settled = render(element("Other.\n\n:::card\n### A\n\nB", true));
    fireEvent.click(screen.getByTestId("stateful-card"));
    const settling: ReadonlyArray<readonly [string, boolean]> = [
      ["Other.\n\n:::card\n### A\n\nB\n:::\n\nLater prose.\n\nMore pro", true],
      [
        "Other.\n\n:::card\n### A\n\nB\n:::\n\nLater prose.\n\nMore prose.",
        false,
      ],
    ];
    for (const [text, streaming] of settling) {
      settled.rerender(element(text, streaming));
      expect(screen.getByTestId("stateful-card").textContent).toBe("clicks 1");
    }
    expect(
      settled.container
        .querySelectorAll("[data-markdown-preview]")[0]
        ?.contains(screen.getByTestId("stateful-card")),
    ).toBe(true);
    expect(mounts).toBe(1);
  });

  it("keeps a three-backtick code fence inside a block and ends the block at its own closer", () => {
    const parse = vi.fn(parseCard);
    const text = [
      ":::card",
      "### Code",
      "",
      "```js",
      "const a = 1;",
      "",
      "const b = 2;",
      "```",
      "",
      "After the fence.",
      ":::",
      "",
      "Outro.",
    ].join("\n");
    const registry = buildMessageDirectiveRegistry([], {
      blocks: [blockSlot({ parse })],
    });
    const view = render(messageElement(registry, "assistant", text, false));
    const card = screen.getByTestId("card");
    expect(card.getAttribute("data-status")).toBe("closed");
    expect(card.getAttribute("data-source")).toContain("After the fence.\n:::");
    const tree = parse.mock.calls.at(-1)?.[0].tree;
    expect(tree?.children.map((node) => node.type)).toEqual([
      "heading",
      "code",
      "paragraph",
    ]);
    expect(paragraphTexts(view.container)).toEqual(["Outro."]);
  });

  it("renders a block as ordinary Markdown between its marker lines without a plugin", () => {
    const text =
      ":::card\n### Code\n\n```js\nconst a = 1;\n```\n\nAfter the fence.\n:::\n\nOutro.";
    const directiveOnly = buildMessageDirectiveRegistry([
      {
        id: "inline-vis",
        pluginId: "demo",
        generation: 1,
        component: () => null,
      },
    ]);
    const view = render(
      messageElement(directiveOnly, "assistant", text, false),
    );
    expect(view.container.querySelector("h3")?.textContent).toBe("Code");
    expect(view.container.querySelector("pre")?.textContent).toContain(
      "const a = 1;",
    );
    expect(paragraphTexts(view.container)).toEqual([
      ":::card",
      "After the fence.",
      ":::",
      "Outro.",
    ]);
    expect(view.container.textContent).not.toContain(
      MESSAGE_BLOCK_FAILURE_NOTE,
    );
    view.unmount();

    const plain = render(
      messageElement(
        buildMessageDirectiveRegistry([]),
        "assistant",
        text,
        false,
      ),
    );
    expect(plain.container.querySelector("pre")?.textContent).toContain(
      "const a = 1;",
    );
    expect(paragraphTexts(plain.container)).toEqual([
      ":::card",
      "After the fence.\n:::",
      "Outro.",
    ]);
  });

  it("renders BB's literal block through Original, with claimed fences inside it", () => {
    function DelegatingCard({ Original }: ExperimentalMessageBlockProps) {
      return (
        <section data-testid="delegating-card">
          <Original />
        </section>
      );
    }
    function UiFence(props: ExperimentalCodeFenceRendererProps) {
      return <div data-testid="ui-fence" data-code={props.code} />;
    }
    const fenceRegistry = buildCodeFenceRendererRegistry([
      {
        id: "ui",
        pluginId: "fences",
        generation: 1,
        languages: ["ui"],
        component: UiFence as ComponentType<ExperimentalCodeFenceRendererProps>,
      },
    ]);
    const registry = buildMessageDirectiveRegistry([], {
      blocks: [blockSlot({ component: DelegatingCard })],
    });
    render(
      <CodeFenceRendererRegistryProvider registry={fenceRegistry}>
        {messageElement(
          registry,
          "assistant",
          ":::card\n### Shown\n\n```ui\n{ inner }\n```\n:::",
          false,
        )}
      </CodeFenceRendererRegistryProvider>,
    );
    const wrapper = screen.getByTestId("delegating-card");
    expect(paragraphTexts(wrapper)).toEqual([":::card", ":::"]);
    expect(wrapper.querySelector("h3")?.textContent).toBe("Shown");
    expect(
      wrapper
        .querySelector('[data-testid="ui-fence"]')
        ?.getAttribute("data-code"),
    ).toBe("{ inner }");
  });

  it("counts index per block name, not per plugin", () => {
    const registry = buildMessageDirectiveRegistry([], {
      blocks: [blockSlot(), blockSlot({ name: "note" })],
    });
    render(
      messageElement(
        registry,
        "assistant",
        [
          ":::card\n### A\n:::",
          ":::note\n### B\n:::",
          ":::card\n### C\n:::",
        ].join("\n\n"),
        false,
      ),
    );
    expect(
      screen
        .getAllByTestId("card")
        .map(
          (card) =>
            `${card.getAttribute("data-headings")}:${card.getAttribute("data-index")}`,
        ),
    ).toEqual(["A:0", "B:0", "C:1"]);
  });
});
