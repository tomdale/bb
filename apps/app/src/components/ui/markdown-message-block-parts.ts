import type {
  BlockContent,
  DefinitionContent,
  Paragraph,
  Root,
  RootContent,
} from "mdast";
import type {} from "mdast-util-to-hast";
import type {} from "remark-directive";
import { visit } from "unist-util-visit";
import type { ResolvedMessageDirective } from "@/lib/plugin-slot-resolvers.js";
import type { PluginMessageBlockSlot } from "@/lib/plugin-slots.js";

export const MESSAGE_BLOCK_LIMIT = 8;
export const MESSAGE_BLOCK_SOURCE_LIMIT_BYTES = 64 * 1024;
export const MESSAGE_BLOCK_PARSE_BUDGET_MS = 4;
export const MESSAGE_BLOCK_HAST_NAME = "bb-message-block";
export const MESSAGE_BLOCK_OFFSET_PROPERTY = "dataBlockOffset";

export type ContainerDirectiveNode = Extract<
  RootContent,
  { type: "containerDirective" }
>;

export interface ContainerDirectiveParts {
  closed: boolean;
  closer: string | null;
  content: Array<BlockContent | DefinitionContent>;
  innerEnd: number;
  innerStart: number;
  opener: string;
  source: string;
}

export interface MountedMessageBlock {
  attributes: Readonly<Record<string, string>>;
  closed: boolean;
  inner: string;
  name: string;
  offset: number;
  oversized: boolean;
  slot: PluginMessageBlockSlot | null;
  source: string;
  tree: Root;
}

export interface MessageBlockClaim {
  slot: PluginMessageBlockSlot | null;
}

export const EMPTY_MOUNTED_MESSAGE_BLOCKS: readonly MountedMessageBlock[] = [];

const CONTAINER_OPEN_SEQUENCE_PATTERN = /^[ \t]*(:{3,})/u;
const CONTAINER_CLOSE_LINE_PATTERN = /^[ \t]*(:{3,})[ \t]*$/u;
const TRAILING_LINE_BREAKS_PATTERN = /[\r\n]+$/u;
const MESSAGE_BLOCK_VERSION_PATTERN = /^[1-9][0-9]*$/u;
const MESSAGE_BLOCK_TEXT_ENCODER = new TextEncoder();

function trimCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function trimTrailingLineBreaks(value: string): string {
  return value.replace(TRAILING_LINE_BREAKS_PATTERN, "");
}

export function normalizeDirectiveAttributes(
  attributes: Record<string, string | null | undefined> | null | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }
  return normalized;
}

function reconstructContainerOpener(node: ContainerDirectiveNode): string {
  const attributes = Object.entries(
    normalizeDirectiveAttributes(node.attributes),
  );
  if (attributes.length === 0) {
    return `:::${node.name}`;
  }
  const body = attributes
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  return `:::${node.name}{${body}}`;
}

export function containerDirectiveParts(
  node: ContainerDirectiveNode,
  markdownSource: string,
): ContainerDirectiveParts {
  const content = node.children.filter(
    (child) =>
      child.type !== "paragraph" || child.data?.directiveLabel !== true,
  );
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    start < 0 ||
    end < start ||
    end > markdownSource.length
  ) {
    const opener = reconstructContainerOpener(node);
    return {
      closed: false,
      closer: null,
      content,
      innerEnd: 0,
      innerStart: 0,
      opener,
      source: opener,
    };
  }
  const source = markdownSource.slice(start, end);
  const openerEnd = source.indexOf("\n");
  const opener = trimCarriageReturn(
    openerEnd === -1 ? source : source.slice(0, openerEnd),
  );
  const innerStart = openerEnd === -1 ? end : start + openerEnd + 1;
  const lastLineStart = source.lastIndexOf("\n") + 1;
  const lastLine = trimCarriageReturn(source.slice(lastLineStart));
  const openSize = CONTAINER_OPEN_SEQUENCE_PATTERN.exec(opener)?.[1]?.length;
  const closeSize = CONTAINER_CLOSE_LINE_PATTERN.exec(lastLine)?.[1]?.length;
  const lastContentEnd = content.at(-1)?.position?.end.offset ?? innerStart;
  const closed =
    openerEnd !== -1 &&
    openSize !== undefined &&
    closeSize !== undefined &&
    closeSize >= openSize &&
    lastContentEnd <= start + lastLineStart;
  return {
    closed,
    closer: closed ? lastLine.trim() : null,
    content,
    innerEnd: closed ? start + lastLineStart : end,
    innerStart,
    opener,
    source,
  };
}

function literalParagraph(value: string): Paragraph {
  return { type: "paragraph", children: [{ type: "text", value }] };
}

export function literalContainerDirectiveChildren(
  parts: ContainerDirectiveParts,
): Array<BlockContent | DefinitionContent> {
  return [
    literalParagraph(parts.opener),
    ...parts.content,
    ...(parts.closer === null ? [] : [literalParagraph(parts.closer)]),
  ];
}

export function claimMessageBlock(
  entry: ResolvedMessageDirective | undefined,
): MessageBlockClaim | null {
  if (entry === undefined) {
    return null;
  }
  if (entry.status === "collision") {
    return entry.kinds.includes("block") ? { slot: null } : null;
  }
  return entry.kind === "block" ? { slot: entry.slot } : null;
}

export function cloneShiftedMarkdownNodes(
  nodes: readonly RootContent[],
  offsetDelta: number,
  lineDelta: number,
): RootContent[] {
  const copy = structuredClone([...nodes]);
  if (offsetDelta === 0 && lineDelta === 0) {
    return copy;
  }
  const root: Root = { type: "root", children: copy };
  visit(root, (node) => {
    const position = node.position;
    if (position === undefined || node.type === "root") return;
    position.start.line += lineDelta;
    position.end.line += lineDelta;
    if (position.start.offset !== undefined) {
      position.start.offset += offsetDelta;
    }
    if (position.end.offset !== undefined) {
      position.end.offset += offsetDelta;
    }
  });
  return copy;
}

function exceedsMessageBlockSourceLimit(inner: string): boolean {
  if (inner.length * 3 <= MESSAGE_BLOCK_SOURCE_LIMIT_BYTES) {
    return false;
  }
  return (
    inner.length > MESSAGE_BLOCK_SOURCE_LIMIT_BYTES ||
    MESSAGE_BLOCK_TEXT_ENCODER.encode(inner).length >
      MESSAGE_BLOCK_SOURCE_LIMIT_BYTES
  );
}

export interface CreateMountedMessageBlockArgs {
  attributes: Readonly<Record<string, string>>;
  claim: MessageBlockClaim;
  closed: boolean;
  inner: string;
  name: string;
  offset: number;
  source: string;
  tree: RootContent[];
}

export function createMountedMessageBlock({
  attributes,
  claim,
  closed,
  inner,
  name,
  offset,
  source,
  tree,
}: CreateMountedMessageBlockArgs): MountedMessageBlock {
  const trimmedInner = trimTrailingLineBreaks(inner);
  return {
    attributes,
    closed,
    inner: trimmedInner,
    name,
    offset,
    oversized: exceedsMessageBlockSourceLimit(trimmedInner),
    slot: claim.slot,
    source: trimTrailingLineBreaks(source),
    tree: { type: "root", children: tree },
  };
}

export function messageBlockFromContainerNode(args: {
  claim: MessageBlockClaim;
  markdownSource: string;
  node: ContainerDirectiveNode;
  offset: number;
  parts: ContainerDirectiveParts;
}): MountedMessageBlock {
  const { claim, markdownSource, node, offset, parts } = args;
  const openerLine = node.position?.start.line ?? 1;
  return createMountedMessageBlock({
    attributes: normalizeDirectiveAttributes(node.attributes),
    claim,
    closed: parts.closed,
    inner: markdownSource.slice(parts.innerStart, parts.innerEnd),
    name: node.name,
    offset,
    source: parts.source,
    tree: cloneShiftedMarkdownNodes(
      parts.content,
      -parts.innerStart,
      -openerLine,
    ),
  });
}

export function messageBlockVersion(
  attributes: Readonly<Record<string, string>>,
): number | null {
  const raw = attributes.v;
  if (raw === undefined) {
    return 1;
  }
  return MESSAGE_BLOCK_VERSION_PATTERN.test(raw) ? Number(raw) : null;
}
