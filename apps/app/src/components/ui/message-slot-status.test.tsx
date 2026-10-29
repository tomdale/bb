// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExperimentalCodeFenceRendererProps,
  ExperimentalCodeFenceStatus,
  ExperimentalMessageBlockProps,
} from "@get-bb/plugin-sdk";
import { resetAllCrashedPluginSlotsForTest } from "@/components/plugin/PluginSlotMount";
import { ConversationMessageContent } from "@/components/thread/timeline/ConversationMessageContent";
import { ThreadTimelineRows } from "@/components/thread/timeline/ThreadTimelineRows";
import { RouteNavigationProvider } from "@/components/ui/app-route-anchor";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import { conversationRow, toolRow } from "@/test/fixtures/thread-timeline-rows";
import {
  buildCodeFenceRendererRegistry,
  CodeFenceRendererRegistryProvider,
} from "./markdown-code-fence-renderers";
import {
  buildMessageDirectiveRegistry,
  MessageDirectiveRegistryProvider,
} from "./markdown-message-directives";

type Slot = "block" | "fence";

const seen: Array<{ slot: Slot; status: ExperimentalCodeFenceStatus }> = [];

function statuses(slot: Slot): ExperimentalCodeFenceStatus[] {
  return seen
    .filter((entry) => entry.slot === slot)
    .map((entry) => entry.status)
    .filter((status, index, all) => index === 0 || all[index - 1] !== status);
}

function Block({ status }: ExperimentalMessageBlockProps) {
  seen.push({ slot: "block", status });
  return <div data-testid="block" data-status={status} />;
}

function Fence({ status }: ExperimentalCodeFenceRendererProps) {
  seen.push({ slot: "fence", status });
  return <div data-testid="fence" data-status={status} />;
}

const BLOCK_SLOT = {
  pluginId: "probe",
  generation: 1,
  name: "card",
  versions: [1],
  parse: () => ({ ok: true as const, data: null }),
  toText: () => "",
  component: Block,
};

const directiveRegistry = buildMessageDirectiveRegistry([], {
  blocks: [BLOCK_SLOT],
});
const fenceRegistry = buildCodeFenceRendererRegistry([
  {
    id: "probe",
    pluginId: "probe",
    generation: 1,
    languages: ["probe"],
    component: Fence,
  },
]);

const SOURCES: Record<Slot, { closed: string; open: string }> = {
  block: {
    open: "Intro.\n\n:::card\n### A\nPartial",
    closed: "Intro.\n\n:::card\n### A\nPartial text.\n:::",
  },
  fence: {
    open: "Intro.\n\n```probe\nfirst",
    closed: "Intro.\n\n```probe\nfirst\nsecond\n```",
  },
};

function message(text: string, streaming: boolean, textComplete: boolean) {
  return (
    <MemoryRouter>
      <RouteNavigationProvider>
        <CodeFenceRendererRegistryProvider registry={fenceRegistry}>
          <MessageDirectiveRegistryProvider registry={directiveRegistry}>
            <ConversationMessageContent
              role="assistant"
              attachments={null}
              id="msg_a"
              threadId="thr_a"
              turnId="turn_a"
              showActions={false}
              mobileActionDisplay="overflow"
              streaming={streaming}
              text={text}
              textComplete={textComplete}
              timestamp={0}
              projectId="proj_a"
            />
          </MessageDirectiveRegistryProvider>
        </CodeFenceRendererRegistryProvider>
      </RouteNavigationProvider>
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  seen.length = 0;
  resetAllCrashedPluginSlotsForTest();
  resetPluginSlotStoreForTest();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe.each(["block", "fence"] as const)("%s status", (slot) => {
  const OPEN = SOURCES[slot].open;
  const CLOSED = SOURCES[slot].closed;

  it("stays streaming while the message's text is incomplete, even when the message is no longer the live row", () => {
    const view = render(message(OPEN, true, false));
    view.rerender(message(OPEN, false, false));
    expect(statuses(slot)).toEqual(["streaming"]);

    view.rerender(message(CLOSED, false, true));
    expect(statuses(slot)).toEqual(["streaming", "closed"]);
  });

  it("goes from streaming to closed without an unclosed render when the closer and completion arrive together", () => {
    const view = render(message(OPEN, true, false));
    view.rerender(message(CLOSED, false, true));
    expect(statuses(slot)).toEqual(["streaming", "closed"]);
  });

  it("reports unclosed once the message's text is complete without a closer, while the turn is still running", () => {
    const view = render(message(OPEN, true, false));
    view.rerender(message(OPEN, true, true));
    expect(statuses(slot)).toEqual(["streaming", "unclosed"]);
  });

  it("draws a stored message with its final status on the first render", () => {
    render(message(CLOSED, false, true));
    cleanup();
    render(message(OPEN, false, true));
    expect(statuses(slot)).toEqual(["closed", "unclosed"]);
  });

  it("stays streaming in the timeline when a tool row follows its incomplete message", () => {
    setPluginSlotRegistrations(
      "probe",
      makePluginRegistrationSet({
        messageBlocks: [
          {
            name: "card",
            versions: [1],
            parse: BLOCK_SLOT.parse,
            toText: BLOCK_SLOT.toText,
            component: Block,
          },
        ],
        codeFenceRenderers: [
          { id: "probe", languages: ["probe"], component: Fence },
        ],
      }),
    );
    const timeline = (text: string, textComplete: boolean) => (
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ThreadTimelineRows
            threadId="thr_main"
            projectId="proj_main"
            timelineRows={[
              conversationRow({
                id: "asst_1",
                role: "assistant",
                seq: 1,
                text,
                textComplete,
                threadId: "thr_main",
                turnId: "turn_1",
              }),
              toolRow({
                id: "tool_1",
                seq: 2,
                status: "pending",
                threadId: "thr_main",
                turnId: "turn_1",
              }),
            ]}
            threadRuntimeDisplayStatus="active"
            workspaceRootPath={undefined}
          />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const view = render(timeline(OPEN, false));
    expect(statuses(slot)).toEqual(["streaming"]);

    view.rerender(timeline(CLOSED, true));
    expect(statuses(slot)).toEqual(["streaming", "closed"]);
  });
});
