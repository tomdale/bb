import { useState } from "react";
import { buildSidebarEntitySectionId } from "@bb/client-core";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { SidebarStickyStack } from "@/components/ui/sidebar";
import { makeThreadListEntry } from "../../../.ladle/story-fixtures";
import { ChronologicalSectionThreadSections } from "./ProjectRow";

export default { title: "sidebar/Custom section hierarchy" };

const sections = [
  { id: "sec_reviews", name: "Agent PR safety reviews" },
  { id: "sec_access", name: "BB access & provider fixes" },
  { id: "sec_work", name: "Organize agent work" },
];
const threads = [
  makeThreadListEntry({
    id: "thr_review",
    sectionId: "sec_reviews",
    title: "Review publication approvals",
  }),
  makeThreadListEntry({
    id: "thr_adapter",
    sectionId: "sec_reviews",
    title: "Review prompt-adapter behavior",
  }),
  makeThreadListEntry({
    id: "thr_boundary",
    sectionId: "sec_reviews",
    title: "Review auto-approval security",
  }),
  makeThreadListEntry({
    id: "thr_browser",
    sectionId: "sec_access",
    title: "Investigate in-app browser access",
    status: "active",
    runtime: { displayStatus: "active", hostReconnectGraceExpiresAt: null },
  }),
  makeThreadListEntry({
    id: "thr_provider",
    sectionId: "sec_access",
    title: "Fix provider ACP launch",
  }),
  makeThreadListEntry({
    id: "thr_phone",
    sectionId: "sec_access",
    title: "Access BB from iPhone",
  }),
  makeThreadListEntry({
    id: "thr_home",
    sectionId: "sec_work",
    title: "Agent home base",
  }),
  makeThreadListEntry({
    id: "thr_child",
    parentThreadId: "thr_home",
    sectionId: null,
    title: "Organize threads into task groups",
  }),
  makeThreadListEntry({
    id: "thr_workforest",
    sectionId: "sec_work",
    title: "Integrate Workforest into BB",
  }),
  makeThreadListEntry({
    id: "thr_import",
    sectionId: "sec_work",
    title: "Import recent tasks",
  }),
];
const noop = () => {};

export function GroupsAndNestedThreads() {
  const [collapsedThreadIds, setCollapsedThreadIds] = useState(
    new Set<string>(),
  );
  const [order, setOrder] = useState(
    sections.map(({ id }) => buildSidebarEntitySectionId("section", id)),
  );
  return (
    <ThreadActionsProvider>
      <div
        className="w-full max-w-sm bg-sidebar p-2 text-sidebar-foreground"
        data-testid="custom-section-hierarchy"
      >
        <SidebarStickyStack>
          <ChronologicalSectionThreadSections
            threadListState={{ status: "ready", threads }}
            compareThreads={() => 0}
            sections={sections}
            selectedThreadId="thr_child"
            collapsedThreadIds={collapsedThreadIds}
            collapsedEnvironmentIds={new Set()}
            onToggleThreadCollapsed={(id) =>
              setCollapsedThreadIds((previous) => {
                const next = new Set(previous);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onToggleEnvironmentCollapsed={noop}
            topLevelSectionOrder={order}
            onTopLevelSectionOrderChange={setOrder}
            pinnedReorderPending={false}
            pinnedThreads={[]}
            onReorderPinnedThread={noop}
            builtInSections={{
              collapsedSectionIds: new Set(),
              onToggleCollapsed: noop,
              pinned: { label: "Pinned", content: null },
              threads: { label: "Threads" },
            }}
          />
        </SidebarStickyStack>
      </div>
    </ThreadActionsProvider>
  );
}
