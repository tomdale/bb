import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type {
  ExperimentalMessageBlockParseResult,
  ExperimentalMessageBlockStatus,
  PluginMessageDirectiveMessage,
} from "@get-bb/plugin-sdk";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount.js";
import type { PluginMessageBlockSlot } from "@/lib/plugin-slots.js";
import {
  EMPTY_MOUNTED_MESSAGE_BLOCKS,
  MESSAGE_BLOCK_LIMIT,
  MESSAGE_BLOCK_PARSE_BUDGET_MS,
  MESSAGE_BLOCK_SOURCE_LIMIT_BYTES,
  messageBlockVersion,
  type MountedMessageBlock,
} from "./markdown-message-block-parts.js";
import {
  MessageDirectiveMountsContext,
  type MessageDirectiveRegistry,
  type MarkdownMessageDirectives,
} from "./markdown-message-directives.js";
import {
  useSlotPortals,
  type SlotPortalHost,
  type SlotPortalReconciliation,
} from "./markdown-slot-portals.js";

import { MessageMarkdownContext } from "./message-block-markdown.js";

export const MESSAGE_BLOCK_FAILURE_NOTE = "Couldn't display this block";

export interface MessageBlockElementProps {
  children?: ReactNode;
  "data-block-offset"?: string;
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "bb-message-block": MessageBlockElementProps;
    }
  }
}

interface MessageBlock {
  complete: boolean;
  mount: MountedMessageBlock;
  original: ReactNode;
}

interface MessageBlockHostValue extends SlotPortalHost<MessageBlock> {
  textComplete: boolean;
}

function reconcileMessageBlock(
  previous: MessageBlock | null,
  next: MessageBlock,
): SlotPortalReconciliation<MessageBlock> {
  if (
    previous !== null &&
    previous.mount.source === next.mount.source &&
    previous.mount.closed === next.mount.closed &&
    previous.mount.slot === next.mount.slot &&
    previous.complete === next.complete
  ) {
    return {
      block: { ...next, mount: previous.mount },
      changed: false,
    };
  }
  return { block: next, changed: true };
}

export const MessageBlockMountsContext = createContext<
  readonly MountedMessageBlock[]
>(EMPTY_MOUNTED_MESSAGE_BLOCKS);

const MessageBlockHostContext = createContext<MessageBlockHostValue | null>(
  null,
);

const MessageBlockOriginalContext = createContext<ReactNode>(null);

function MessageBlockOriginal() {
  return <>{useContext(MessageBlockOriginalContext)}</>;
}

export function registryHasMessageBlocks(
  registry: MessageDirectiveRegistry | null,
): boolean {
  if (registry === null) {
    return false;
  }
  for (const entry of registry.values()) {
    if (
      entry.status === "collision"
        ? entry.kinds.includes("block")
        : entry.kind === "block"
    ) {
      return true;
    }
  }
  return false;
}

function isParseResult(
  value: unknown,
): value is ExperimentalMessageBlockParseResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const result = value as { ok?: unknown; data?: unknown; error?: unknown };
  return result.ok === true
    ? "data" in result && result.data !== undefined
    : result.ok === false && typeof result.error === "string";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function runMessageBlockParse(
  slot: PluginMessageBlockSlot,
  mount: MountedMessageBlock,
  status: ExperimentalMessageBlockStatus,
  version: number,
): ExperimentalMessageBlockParseResult {
  const final = status !== "streaming";
  const started = final ? performance.now() : 0;
  let result: unknown;
  try {
    result = slot.parse(
      { attributes: mount.attributes, source: mount.inner, tree: mount.tree },
      { status, version },
    );
  } catch (error) {
    return { ok: false, error: `parse threw: ${errorMessage(error)}` };
  }
  if (!isParseResult(result)) {
    return { ok: false, error: "parse returned an invalid result" };
  }
  if (final) {
    const elapsed = performance.now() - started;
    if (elapsed > MESSAGE_BLOCK_PARSE_BUDGET_MS) {
      return {
        ok: false,
        error: `parse took ${elapsed.toFixed(1)} ms, over the ${MESSAGE_BLOCK_PARSE_BUDGET_MS} ms budget`,
      };
    }
  }
  return result;
}

function blockWarning(name: string, pluginId: string | null, reason: string) {
  return pluginId === null
    ? `[plugin] message block "${name}" ${reason}; rendering as literal text`
    : `[plugin:${pluginId}] message block "${name}" ${reason}; rendering as literal text`;
}

function messageBlockRefusal(
  mount: MountedMessageBlock,
  ordinal: number,
  version: number | null,
): string | null {
  const slot = mount.slot;
  if (slot === null) {
    return blockWarning(mount.name, null, "is claimed by more than one plugin");
  }
  if (ordinal >= MESSAGE_BLOCK_LIMIT) {
    return blockWarning(
      mount.name,
      slot.pluginId,
      `is past the limit of ${MESSAGE_BLOCK_LIMIT} blocks per message`,
    );
  }
  if (mount.oversized) {
    return blockWarning(
      mount.name,
      slot.pluginId,
      `is larger than ${MESSAGE_BLOCK_SOURCE_LIMIT_BYTES / 1024} KiB`,
    );
  }
  if (version === null || !slot.versions.includes(version)) {
    return blockWarning(
      mount.name,
      slot.pluginId,
      `has version ${JSON.stringify(mount.attributes.v ?? "")}, which the plugin does not render`,
    );
  }
  return null;
}

function MessageBlockFallback({
  note,
  warning,
}: {
  note: boolean;
  warning: string | null;
}) {
  const logged = note ? warning : null;
  useEffect(() => {
    if (logged !== null) {
      console.warn(logged);
    }
  }, [logged]);
  return (
    <>
      <MessageBlockOriginal />
      {note ? (
        <p
          className="mb-2 text-xs text-muted-foreground last:mb-0"
          data-message-block-note=""
        >
          {MESSAGE_BLOCK_FAILURE_NOTE}
        </p>
      ) : null}
    </>
  );
}

interface MessageBlockMountProps {
  index: number;
  message: PluginMessageDirectiveMessage;
  mount: MountedMessageBlock;
  ordinal: number;
  status: ExperimentalMessageBlockStatus;
}

const MessageBlockMount = memo(function MessageBlockMount({
  index,
  message,
  mount,
  ordinal,
  status,
}: MessageBlockMountProps) {
  const version = messageBlockVersion(mount.attributes);
  const refusal = messageBlockRefusal(mount, ordinal, version);
  const final = status !== "streaming";
  const slot = refusal === null ? mount.slot : null;
  const result = useMemo(
    () =>
      slot === null || version === null
        ? null
        : runMessageBlockParse(slot, mount, status, version),
    [slot, mount, status, version],
  );
  if (slot === null || result === null) {
    return <MessageBlockFallback note={final} warning={refusal} />;
  }
  if (!result.ok && final) {
    return (
      <MessageBlockFallback
        note
        warning={blockWarning(
          mount.name,
          slot.pluginId,
          `could not be parsed (${result.error})`,
        )}
      />
    );
  }
  const Component = slot.component;
  const element = (
    <Component
      data={result.ok ? result.data : null}
      error={result.ok ? null : result.error}
      index={index}
      message={message}
      Original={MessageBlockOriginal}
      source={mount.source}
      status={status}
    />
  );
  return (
    <PluginSlotMount
      key={`${slot.pluginId}/${slot.name}/${slot.generation}`}
      pluginId={slot.pluginId}
      slotKind="messageBlock"
      slotId={slot.name}
      instanceId={`${message.id}#${mount.name}#${index}`}
      crashResetKey={`${status}\n${mount.source}`}
      crashFallback={<MessageBlockFallback note={final} warning={null} />}
    >
      {element}
    </PluginSlotMount>
  );
});

interface MessageBlockHostProps {
  children: ReactNode;
  message: PluginMessageDirectiveMessage;
  textComplete: boolean;
  messageDirectives?: MarkdownMessageDirectives;
}

export function MessageBlockHost({
  children,
  message,
  textComplete,
  messageDirectives,
}: MessageBlockHostProps) {
  const {
    entries,
    host: portals,
    parkingRef,
  } = useSlotPortals(reconcileMessageBlock);
  const host = useMemo(
    (): MessageBlockHostValue => ({ ...portals, textComplete }),
    [portals, textComplete],
  );
  const markdownContext = useMemo(
    () => ({ directives: messageDirectives, message, textComplete }),
    [messageDirectives, message, textComplete],
  );
  const indexes = new Map<string, number>();
  const mounts: ReactNode[] = [];
  for (const entry of entries) {
    const { block } = entry;
    if (block === null) {
      continue;
    }
    const { mount } = block;
    const index = indexes.get(mount.name) ?? 0;
    indexes.set(mount.name, index + 1);
    mounts.push(
      createPortal(
        <MessageBlockOriginalContext.Provider value={block.original}>
          <MessageMarkdownContext.Provider value={markdownContext}>
            <MessageBlockMount
              index={index}
              message={message}
              mount={mount}
              ordinal={mounts.length}
              status={
                mount.closed
                  ? "closed"
                  : block.complete
                    ? "unclosed"
                    : "streaming"
              }
            />
          </MessageMarkdownContext.Provider>
        </MessageBlockOriginalContext.Provider>,
        entry.container,
        String(entry.offset),
      ),
    );
  }

  return (
    <MessageBlockHostContext.Provider value={host}>
      {children}
      {mounts.length === 0 ? null : (
        <div ref={parkingRef} hidden data-message-block-parking="" />
      )}
      {mounts}
    </MessageBlockHostContext.Provider>
  );
}

interface MessageBlockPlaceholderProps extends MessageBlockElementProps {
  sourceOffset: number;
  wrapOriginal: (children: ReactNode) => ReactNode;
}

export function MessageBlockPlaceholder({
  children,
  "data-block-offset": rawOffset,
  sourceOffset,
  wrapOriginal,
}: MessageBlockPlaceholderProps) {
  const host = useContext(MessageBlockHostContext);
  const mounts = useContext(MessageBlockMountsContext);
  const directiveMounts = useContext(MessageDirectiveMountsContext);
  const elementRef = useRef<HTMLDivElement>(null);
  const localOffset = rawOffset === undefined ? Number.NaN : Number(rawOffset);
  const mount = mounts.find((candidate) => candidate.offset === localOffset);
  const hosted = host !== null && mount !== undefined;
  const offset = sourceOffset + localOffset;

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (host === null || !hosted || element === null) {
      return;
    }
    host.attach(offset, element);
    return () => {
      host.detach(offset, element);
    };
  }, [host, hosted, offset]);

  useLayoutEffect(() => {
    if (host === null || mount === undefined) {
      return;
    }
    host.update(offset, {
      complete: host.textComplete,
      mount,
      original: (
        <MessageDirectiveMountsContext.Provider value={directiveMounts}>
          {wrapOriginal(children)}
        </MessageDirectiveMountsContext.Provider>
      ),
    });
  });

  if (!hosted) {
    return <>{children}</>;
  }
  return (
    <div
      ref={elementRef}
      className="mb-2 last:mb-0"
      data-message-block-placeholder=""
    />
  );
}
