import {
  Fragment,
  cloneElement,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown, {
  type Components,
  type Options as ReactMarkdownOptions,
  type UrlTransform,
} from "react-markdown";
import type { Nodes, Root, RootContent } from "mdast";
import { EXIT, visit } from "unist-util-visit";
import {
  closesMarkdownContainer,
  findMarkdownContainerExtent,
  parseMarkdownContainerOpen,
  type MarkdownContainerFence,
} from "./markdown-container-fences.js";
import {
  claimMessageBlock,
  cloneShiftedMarkdownNodes,
  containerDirectiveParts,
  createMountedMessageBlock,
  EMPTY_MOUNTED_MESSAGE_BLOCKS,
  MESSAGE_BLOCK_HAST_NAME,
  normalizeDirectiveAttributes,
  type MountedMessageBlock,
} from "./markdown-message-block-parts.js";
import {
  EMPTY_MOUNTED_MESSAGE_DIRECTIVES,
  MESSAGE_DIRECTIVE_MOUNT_LIMIT,
  remarkMessageDirectives,
  type MessageDirectiveRegistry,
  type MountedMessageDirective,
} from "./markdown-message-directives.js";
import {
  remarkCodeFenceRenderers,
  type CodeFenceRendererRegistry,
} from "./markdown-code-fence-renderers.js";
import {
  BARE_FENCE_PATTERN,
  TRAILING_CLOSE_PATTERN,
} from "./markdown-math-fences.js";
import {
  closesAnyIndentMarkdownFence,
  isMarkdownFenceClose,
  isMarkdownListLikeLine,
  MARKDOWN_LIST_MARKER_PATTERN,
  parseAnyIndentMarkdownFenceStart,
  parseMarkdownFenceStart,
  trimMarkdownLineCarriageReturn,
  type MarkdownFence,
} from "./markdown-prompt-blockquote-boundaries.js";

type MarkdownPluginList = NonNullable<ReactMarkdownOptions["remarkPlugins"]>;

export interface MarkdownPieceRenderConfig {
  codeFenceRendererRegistry: CodeFenceRendererRegistry | null;
  components: Components;
  messageDirectiveRegistry: MessageDirectiveRegistry | null;
  rehypePlugins: MarkdownPluginList;
  remarkPlugins: MarkdownPluginList;
  urlTransform: UrlTransform | undefined;
}

interface MarkdownPieceSummary {
  endsOpen: boolean;
  endsWithIndentedCode: boolean;
  hasGlobalConstructs: boolean;
  lastTopLevelType: string | null;
  topLevelCount: number;
}

interface ResolvedMarkdownPieces {
  blockMounts: readonly MountedMessageBlock[];
  children: readonly ReactNode[];
  mounts: readonly MountedMessageDirective[];
}

interface MarkdownElementProps {
  children?: ReactNode;
  node?: object;
}

interface MarkdownPieceEntry {
  blockMounts: readonly MountedMessageBlock[];
  children: readonly ReactNode[];
  container: MarkdownContainerPiece | null;
  mounts: readonly MountedMessageDirective[];
  source: string;
  summary: MarkdownPieceSummary;
  tagCounts: ReadonlyMap<string, number>;
  tree: readonly RootContent[] | null;
}

interface MarkdownContainerPiece {
  closer: MarkdownPieceEntry | null;
  inner: readonly MarkdownPieceEntry[];
  opener: MarkdownPieceEntry;
}

interface MarkdownPieceScope {
  capturesTree: boolean;
  mountBase: number;
  offsets: ReadonlyMap<string, number>;
  sourceOffset: number;
  topLevel: boolean;
}

interface MarkdownTreeCapture {
  lineDelta: number;
  offsetDelta: number;
}

export interface MarkdownPieceCache {
  config: MarkdownPieceRenderConfig | null;
  entries: readonly MarkdownPieceEntry[];
  latchedWholeDocumentPrefix: string | null;
  resolved: { body: string; result: ResolvedMarkdownPieces } | null;
}

interface MarkdownPieceSummaryTarget {
  source: string;
  summary: MarkdownPieceSummary;
}

interface ParseMarkdownPieceArgs {
  capture: MarkdownTreeCapture | null;
  config: MarkdownPieceRenderConfig;
  indexBase: number;
  offsets: ReadonlyMap<string, number>;
  source: string;
  sourceOffset: number;
  topLevel: boolean;
}

const MARKDOWN_BLANK_LINE_PATTERN = /^[ \t]*$/u;
const MARKDOWN_PIECE_START_PATTERN = /^\S/u;
const MARKDOWN_PIECE_LIST_MARKER_PATTERN = /(?:[-*+]|\d{1,9}[.)])(?:\s|$)/uy;
const MARKDOWN_MATH_FLOW_OPEN_PATTERN = /^ {0,3}\$\$[^$]*$/u;
const MARKDOWN_MATH_FLOW_SEQUENCE_PATTERN = /^ {0,3}(\${2,})/u;
const MARKDOWN_MATH_FLOW_CLOSE_PATTERN = /^ {0,3}(\${2,})[ \t]*$/u;
const MARKDOWN_LEADING_WHITESPACE_PATTERN = /^[ \t]/u;
const MARKDOWN_HTML_RAW_OPEN_PATTERN =
  /^<(?:pre|script|style|textarea)(?:[\s>]|$)/iu;
const MARKDOWN_HTML_RAW_CLOSE_PATTERN = /<\/(?:pre|script|style|textarea)>/iu;
const MARKDOWN_HTML_DECLARATION_OPEN_PATTERN = /^<![A-Za-z]/u;
const MARKDOWN_HTML_INDENT_PATTERN = /^ {0,3}/u;
const MARKDOWN_ROOT_KEY_PATTERN = /^(.+)-(\d+)$/u;
const MARKDOWN_LIST_CONTINUATION_TYPES = new Set([
  "footnoteDefinition",
  "list",
]);
const MARKDOWN_GLOBAL_CONSTRUCT_TYPES = new Set([
  "definition",
  "footnoteDefinition",
  "footnoteReference",
]);
const UNKEYED_MARKDOWN_ROOT_NAME = "#unkeyed";
const EMPTY_MARKDOWN_TAG_COUNTS: ReadonlyMap<string, number> = new Map();
const EMPTY_MARKDOWN_PIECE_SUMMARY: MarkdownPieceSummary = {
  endsOpen: false,
  endsWithIndentedCode: false,
  hasGlobalConstructs: false,
  lastTopLevelType: null,
  topLevelCount: 0,
};
const CONTAINER_MARKDOWN_PIECE_SUMMARY: MarkdownPieceSummary = {
  ...EMPTY_MARKDOWN_PIECE_SUMMARY,
  lastTopLevelType: "containerDirective",
  topLevelCount: 1,
};
const TOP_LEVEL_MARKDOWN_PIECE_SCOPE: MarkdownPieceScope = {
  capturesTree: false,
  mountBase: 0,
  offsets: EMPTY_MARKDOWN_TAG_COUNTS,
  sourceOffset: 0,
  topLevel: true,
};

export function findMarkdownPieceCandidates(body: string): readonly number[] {
  const candidates: number[] = [];
  let fence: MarkdownFence | null = null;
  let container: MarkdownContainerFence | null = null;
  let mathOpen = false;
  let previousLineBlank = false;
  let lastNonBlankLine: string | null = null;
  let lineStart = 0;
  while (lineStart < body.length) {
    const newline = body.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? body.length : newline;
    const line = trimMarkdownLineCarriageReturn(body.slice(lineStart, lineEnd));
    const blank = MARKDOWN_BLANK_LINE_PATTERN.test(line);
    if (container !== null) {
      if (closesMarkdownContainer(line, container)) {
        container = null;
      }
    } else if (fence !== null) {
      if (closesAnyIndentMarkdownFence(line, fence)) {
        fence = null;
      }
    } else if (mathOpen) {
      if (BARE_FENCE_PATTERN.test(line) || TRAILING_CLOSE_PATTERN.test(line)) {
        mathOpen = false;
      }
    } else if (!blank) {
      if (
        previousLineBlank &&
        lastNonBlankLine !== null &&
        MARKDOWN_PIECE_START_PATTERN.test(line) &&
        !(
          isMarkdownListLikeLine(lastNonBlankLine) &&
          MARKDOWN_LIST_MARKER_PATTERN.test(line)
        )
      ) {
        candidates.push(lineStart);
      }
      container = parseMarkdownContainerOpen(line);
      fence =
        container === null ? parseAnyIndentMarkdownFenceStart(line) : null;
      if (
        container === null &&
        fence === null &&
        MARKDOWN_MATH_FLOW_OPEN_PATTERN.test(line)
      ) {
        mathOpen = true;
      }
    }
    if (!blank) {
      lastNonBlankLine = line;
    }
    previousLineBlank = blank;
    lineStart = newline === -1 ? body.length : newline + 1;
  }
  return candidates;
}

function markdownNodeSource(node: Nodes, source: string): string | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined || end < start) {
    return null;
  }
  return source.slice(start, end);
}

function isIndentedMarkdownCode(slice: string): boolean {
  return (
    parseMarkdownFenceStart(slice) === null &&
    MARKDOWN_LEADING_WHITESPACE_PATTERN.test(slice)
  );
}

function isMarkdownCodeOpen(slice: string): boolean {
  const lines = slice.split("\n");
  const fence = parseMarkdownFenceStart(lines[0] ?? "");
  if (fence === null) {
    return !isIndentedMarkdownCode(slice);
  }
  return lines.length < 2 || !isMarkdownFenceClose(lines.at(-1) ?? "", fence);
}

function isMarkdownMathOpen(slice: string): boolean {
  const lines = slice.split("\n");
  const open = MARKDOWN_MATH_FLOW_SEQUENCE_PATTERN.exec(lines[0] ?? "");
  if (open === null || lines.length < 2) {
    return true;
  }
  const close = MARKDOWN_MATH_FLOW_CLOSE_PATTERN.exec(
    trimMarkdownLineCarriageReturn(lines.at(-1) ?? ""),
  );
  return close === null || close[1]!.length < open[1]!.length;
}

function isMarkdownHtmlOpen(value: string): boolean {
  const html = value.replace(MARKDOWN_HTML_INDENT_PATTERN, "");
  if (MARKDOWN_HTML_RAW_OPEN_PATTERN.test(html)) {
    return !MARKDOWN_HTML_RAW_CLOSE_PATTERN.test(html);
  }
  if (html.startsWith("<!--")) {
    return !html.includes("-->", 4);
  }
  if (html.startsWith("<![CDATA[")) {
    return !html.includes("]]>", 9);
  }
  if (html.startsWith("<?")) {
    return !html.includes("?>", 2);
  }
  if (MARKDOWN_HTML_DECLARATION_OPEN_PATTERN.test(html)) {
    return !html.includes(">", 2);
  }
  return false;
}

function isMarkdownNodeOpen(node: Nodes, source: string): boolean {
  if (node.type === "containerDirective") {
    return !containerDirectiveParts(node, source).closed;
  }
  if (node.type === "html") {
    return isMarkdownHtmlOpen(node.value);
  }
  if (node.type !== "code" && node.type !== "math") {
    return false;
  }
  const slice = markdownNodeSource(node, source);
  if (slice === null) {
    return true;
  }
  return node.type === "code"
    ? isMarkdownCodeOpen(slice)
    : isMarkdownMathOpen(slice);
}

function markdownLastDescendantChainIsOpen(
  tree: Root,
  source: string,
): boolean {
  let node: Nodes | undefined = tree.children[tree.children.length - 1];
  while (node !== undefined) {
    if (isMarkdownNodeOpen(node, source)) {
      return true;
    }
    node =
      "children" in node ? node.children[node.children.length - 1] : undefined;
  }
  return false;
}

function markdownTreeHasGlobalConstructs(tree: Root): boolean {
  let found = false;
  visit(tree, (node) => {
    if (MARKDOWN_GLOBAL_CONSTRUCT_TYPES.has(node.type)) {
      found = true;
      return EXIT;
    }
    return undefined;
  });
  return found;
}

function endsWithIndentedMarkdownCode(tree: Root, source: string): boolean {
  const last = tree.children[tree.children.length - 1];
  if (last?.type !== "code") {
    return false;
  }
  const slice = markdownNodeSource(last, source);
  return slice === null || isIndentedMarkdownCode(slice);
}

function remarkMarkdownPieceSummary(target: MarkdownPieceSummaryTarget) {
  return (tree: Root): void => {
    const { source } = target;
    target.summary = {
      endsOpen: markdownLastDescendantChainIsOpen(tree, source),
      endsWithIndentedCode: endsWithIndentedMarkdownCode(tree, source),
      hasGlobalConstructs:
        (source.includes("]:") || source.includes("[^")) &&
        markdownTreeHasGlobalConstructs(tree),
      lastTopLevelType: tree.children[tree.children.length - 1]?.type ?? null,
      topLevelCount: tree.children.length,
    };
  };
}

function markdownRootChildren(element: ReactElement): readonly ReactNode[] {
  if (element.type !== Fragment) {
    return [element];
  }
  const { children } = element.props as { children?: ReactNode };
  if (children === undefined || children === null) {
    return [];
  }
  return Array.isArray(children) ? children : [children];
}

function parseMarkdownRootKey(
  key: string | null,
): { count: number; name: string } | null {
  if (key === null) {
    return null;
  }
  const match = MARKDOWN_ROOT_KEY_PATTERN.exec(key);
  if (match === null) {
    return null;
  }
  return { count: Number(match[2]), name: match[1]! };
}

function rekeyMarkdownRootChildren(
  children: readonly ReactNode[],
  offsets: ReadonlyMap<string, number>,
): { children: readonly ReactNode[]; tagCounts: ReadonlyMap<string, number> } {
  const tagCounts = new Map<string, number>();
  const rekeyed = children.map((child) => {
    if (!isValidElement(child)) {
      return child;
    }
    const parsedKey = parseMarkdownRootKey(child.key);
    if (child.key !== null && parsedKey === null) {
      return child;
    }
    const name = parsedKey?.name ?? UNKEYED_MARKDOWN_ROOT_NAME;
    const count = tagCounts.get(name) ?? 0;
    tagCounts.set(name, count + 1);
    const documentCount = count + (offsets.get(name) ?? 0);
    if (parsedKey !== null && documentCount === parsedKey.count) {
      return child;
    }
    return cloneElement(child, { key: `${name}-${documentCount}` });
  });
  return { children: rekeyed, tagCounts };
}

function parseMarkdownPiece({
  capture,
  config,
  indexBase,
  offsets,
  source,
  sourceOffset,
  topLevel,
}: ParseMarkdownPieceArgs): MarkdownPieceEntry {
  const summaryTarget: MarkdownPieceSummaryTarget = {
    source,
    summary: EMPTY_MARKDOWN_PIECE_SUMMARY,
  };
  const mounts: MountedMessageDirective[] = [];
  const blockMounts: MountedMessageBlock[] = [];
  let tree: readonly RootContent[] | null = null;
  const remarkPlugins: MarkdownPluginList = [
    [remarkMarkdownPieceSummary, summaryTarget],
    ...config.remarkPlugins,
  ];
  if (capture !== null) {
    remarkPlugins.push(() => (root: Root) => {
      tree = cloneShiftedMarkdownNodes(
        root.children,
        capture.offsetDelta,
        capture.lineDelta,
      );
    });
  }
  if (config.messageDirectiveRegistry !== null) {
    remarkPlugins.push([
      remarkMessageDirectives,
      {
        blockMounts,
        indexBase,
        limit: Math.max(0, MESSAGE_DIRECTIVE_MOUNT_LIMIT - indexBase),
        mounts,
        registry: config.messageDirectiveRegistry,
        sourceOffset,
        topLevel,
      },
    ]);
  }
  if (config.codeFenceRendererRegistry !== null) {
    remarkPlugins.push([
      remarkCodeFenceRenderers,
      { registry: config.codeFenceRendererRegistry, sourceOffset },
    ]);
  }
  remarkPlugins.push(() => (tree: Root) => {
    visit(tree, "image", (node) => {
      if (node.position?.start.offset === undefined) return;
      node.data ??= {};
      node.data.hProperties = {
        ...node.data.hProperties,
        "data-markdown-image-offset": sourceOffset + node.position.start.offset,
      };
    });
  });
  const element = ReactMarkdown({
    children: source,
    components: config.components,
    rehypePlugins: config.rehypePlugins,
    remarkPlugins,
    urlTransform: config.urlTransform,
  });
  const { children, tagCounts } = rekeyMarkdownRootChildren(
    markdownRootChildren(element),
    offsets,
  );
  return {
    blockMounts:
      blockMounts.length === 0 ? EMPTY_MOUNTED_MESSAGE_BLOCKS : blockMounts,
    children,
    container: null,
    mounts: mounts.length === 0 ? EMPTY_MOUNTED_MESSAGE_DIRECTIVES : mounts,
    source,
    summary: summaryTarget.summary,
    tagCounts,
    tree,
  };
}

function markdownPieceNeedsMerge(
  summary: MarkdownPieceSummary,
  body: string,
  end: number,
): boolean {
  if (summary.endsOpen || summary.endsWithIndentedCode) {
    return true;
  }
  if (
    summary.lastTopLevelType === null ||
    !MARKDOWN_LIST_CONTINUATION_TYPES.has(summary.lastTopLevelType)
  ) {
    return false;
  }
  MARKDOWN_PIECE_LIST_MARKER_PATTERN.lastIndex = end;
  return MARKDOWN_PIECE_LIST_MARKER_PATTERN.test(body);
}

function addMarkdownTagCounts(
  target: Map<string, number>,
  tagCounts: ReadonlyMap<string, number>,
): void {
  for (const [name, count] of tagCounts) {
    target.set(name, (target.get(name) ?? 0) + count);
  }
}

interface ResolveMarkdownContainerPieceArgs {
  body: string;
  config: MarkdownPieceRenderConfig;
  mountBase: number;
  offsets: ReadonlyMap<string, number>;
  previous: MarkdownPieceEntry | undefined;
  sourceOffset: number;
  start: number;
}

const OPENER_TREE_CAPTURE: MarkdownTreeCapture = {
  lineDelta: 0,
  offsetDelta: 0,
};

function countLineBreaks(value: string): number {
  let count = 0;
  let index = value.indexOf("\n");
  while (index !== -1) {
    count += 1;
    index = value.indexOf("\n", index + 1);
  }
  return count;
}

function globalConstructPiece(source: string): MarkdownPieceEntry {
  return {
    blockMounts: EMPTY_MOUNTED_MESSAGE_BLOCKS,
    children: [],
    container: null,
    mounts: EMPTY_MOUNTED_MESSAGE_DIRECTIVES,
    source,
    summary: { ...CONTAINER_MARKDOWN_PIECE_SUMMARY, hasGlobalConstructs: true },
    tagCounts: EMPTY_MARKDOWN_TAG_COUNTS,
    tree: null,
  };
}

function resolveMarkdownContainerPiece({
  body,
  config,
  mountBase,
  offsets,
  previous,
  sourceOffset,
  start,
}: ResolveMarkdownContainerPieceArgs): MarkdownPieceEntry | null {
  const registry = config.messageDirectiveRegistry;
  if (registry === null) {
    return null;
  }
  const extent = findMarkdownContainerExtent(body, start);
  if (extent === null) {
    return null;
  }
  const source = body.slice(start, extent.end);
  const previousContainer = previous?.container ?? null;
  if (
    previous !== undefined &&
    previousContainer !== null &&
    previous.source === source
  ) {
    return previous;
  }
  const reusesOpener = previousContainer?.opener.source === extent.opener;
  const opener =
    reusesOpener && previousContainer !== null
      ? previousContainer.opener
      : parseMarkdownPiece({
          capture: OPENER_TREE_CAPTURE,
          config,
          indexBase: mountBase,
          offsets,
          source: extent.opener,
          sourceOffset,
          topLevel: false,
        });
  const openerNode = opener.tree?.[0];
  if (
    opener.summary.topLevelCount !== 1 ||
    openerNode === undefined ||
    openerNode.type !== "containerDirective"
  ) {
    return null;
  }
  const claim = claimMessageBlock(registry.get(openerNode.name));
  const partOffsets = new Map(offsets);
  addMarkdownTagCounts(partOffsets, opener.tagCounts);
  const inner = resolveIncrementalMarkdownPieceEntries(
    config,
    body.slice(extent.innerStart, extent.innerEnd),
    reusesOpener && previousContainer !== null ? previousContainer.inner : [],
    {
      capturesTree: claim !== null,
      mountBase: mountBase + opener.mounts.length,
      offsets: partOffsets,
      sourceOffset: sourceOffset + extent.innerStart - start,
      topLevel: false,
    },
  );
  if (inner === null) {
    return globalConstructPiece(source);
  }
  let closerMountBase = mountBase + opener.mounts.length;
  for (const entry of inner) {
    addMarkdownTagCounts(partOffsets, entry.tagCounts);
    closerMountBase += entry.mounts.length;
  }
  const closer =
    extent.closer === null
      ? null
      : parseMarkdownPiece({
          capture: null,
          config,
          indexBase: closerMountBase,
          offsets: partOffsets,
          source: extent.closer,
          sourceOffset: sourceOffset + extent.innerEnd - start,
          topLevel: false,
        });
  const parts =
    closer === null ? [opener, ...inner] : [opener, ...inner, closer];
  const reusedParts = new Set<MarkdownPieceEntry>(
    previousContainer === null
      ? []
      : [previousContainer.opener, ...previousContainer.inner],
  );
  const container: MarkdownContainerPiece = { closer, inner, opener };
  if (claim === null) {
    const joined = joinMarkdownPieceEntries(parts, reusedParts, true);
    return {
      blockMounts: EMPTY_MOUNTED_MESSAGE_BLOCKS,
      children: joined.children,
      container,
      mounts: joined.mounts,
      source,
      summary: CONTAINER_MARKDOWN_PIECE_SUMMARY,
      tagCounts: joined.tagCounts,
      tree: null,
    };
  }
  const joined = joinMarkdownPieceEntries(parts, reusedParts, false);
  const blockMount = createMountedMessageBlock({
    attributes: normalizeDirectiveAttributes(openerNode.attributes),
    claim,
    closed: extent.closer !== null,
    inner: body.slice(extent.innerStart, extent.innerEnd),
    name: openerNode.name,
    offset: sourceOffset,
    source,
    tree: inner.flatMap((entry) => entry.tree ?? []),
  });
  const blockKeyCount = offsets.get(MESSAGE_BLOCK_HAST_NAME) ?? 0;
  const element = createElement(
    config.components[MESSAGE_BLOCK_HAST_NAME] ?? MESSAGE_BLOCK_HAST_NAME,
    {
      "data-block-offset": String(sourceOffset),
      key: `${MESSAGE_BLOCK_HAST_NAME}-${blockKeyCount}`,
    },
    ...joined.children,
  );
  return {
    blockMounts: [blockMount],
    children: [element],
    container,
    mounts: joined.mounts,
    source,
    summary: CONTAINER_MARKDOWN_PIECE_SUMMARY,
    tagCounts: new Map([[MESSAGE_BLOCK_HAST_NAME, 1]]),
    tree: null,
  };
}

function resolveIncrementalMarkdownPieceEntries(
  config: MarkdownPieceRenderConfig,
  body: string,
  previousEntries: readonly MarkdownPieceEntry[],
  scope: MarkdownPieceScope,
): readonly MarkdownPieceEntry[] | null {
  const candidates = findMarkdownPieceCandidates(body);
  const entries: MarkdownPieceEntry[] = [];
  const offsets = new Map(scope.offsets);
  let mountCount = scope.mountBase;
  let lineCount = 0;
  let reusingPreviousEntries = true;
  let start = 0;
  let endIndex = 0;
  while (start < body.length) {
    while (endIndex < candidates.length && candidates[endIndex]! <= start) {
      endIndex += 1;
    }
    const previous = reusingPreviousEntries
      ? previousEntries[entries.length]
      : undefined;
    let entry = scope.topLevel
      ? resolveMarkdownContainerPiece({
          body,
          config,
          mountBase: mountCount,
          offsets,
          previous,
          sourceOffset: scope.sourceOffset + start,
          start,
        })
      : null;
    if (entry === null) {
      const parsePiece = (end: number): MarkdownPieceEntry =>
        parseMarkdownPiece({
          capture: scope.capturesTree
            ? { lineDelta: lineCount, offsetDelta: start }
            : null,
          config,
          indexBase: mountCount,
          offsets,
          source: body.slice(start, end),
          sourceOffset: scope.sourceOffset + start,
          topLevel: scope.topLevel,
        });
      const previousMatches =
        previous !== undefined && body.startsWith(previous.source, start);
      if (previousMatches) {
        const previousEnd = start + previous.source.length;
        let previousEndIndex = endIndex;
        while (
          previousEndIndex < candidates.length &&
          candidates[previousEndIndex]! < previousEnd
        ) {
          previousEndIndex += 1;
        }
        if ((candidates[previousEndIndex] ?? body.length) === previousEnd) {
          endIndex = previousEndIndex;
        } else if (previous.summary.endsOpen) {
          endIndex = candidates.length;
        }
      }
      let end = candidates[endIndex] ?? body.length;
      entry =
        previousMatches && start + previous.source.length === end
          ? previous
          : parsePiece(end);
      let merges = 0;
      while (
        !entry.summary.hasGlobalConstructs &&
        end < body.length &&
        markdownPieceNeedsMerge(entry.summary, body, end)
      ) {
        merges += 1;
        endIndex = merges === 1 ? endIndex + 1 : candidates.length;
        end = candidates[endIndex] ?? body.length;
        entry = parsePiece(end);
      }
    }
    if (entry.summary.hasGlobalConstructs) {
      return null;
    }
    if (entry !== previous) {
      reusingPreviousEntries = false;
    }
    entries.push(entry);
    addMarkdownTagCounts(offsets, entry.tagCounts);
    mountCount += entry.mounts.length;
    if (scope.capturesTree) {
      lineCount += countLineBreaks(entry.source);
    }
    start += entry.source.length;
  }
  return entries;
}

function refreshMarkdownElementTree(child: ReactNode): ReactNode {
  if (Array.isArray(child)) {
    return child.map(refreshMarkdownElementTree);
  }
  if (!isValidElement<MarkdownElementProps>(child)) {
    return child;
  }
  const { children, node } = child.props;
  const props = node === undefined ? undefined : { node: { ...node } };
  if (children === undefined) {
    return cloneElement(child, props);
  }
  if (Array.isArray(children)) {
    return cloneElement(
      child,
      props,
      ...children.map(refreshMarkdownElementTree),
    );
  }
  return cloneElement(child, props, refreshMarkdownElementTree(children));
}

interface JoinedMarkdownPieceEntries {
  blockMounts: readonly MountedMessageBlock[];
  children: readonly ReactNode[];
  mounts: readonly MountedMessageDirective[];
  tagCounts: ReadonlyMap<string, number>;
}

function joinMarkdownPieceEntries(
  entries: readonly MarkdownPieceEntry[],
  reusedEntries: ReadonlySet<MarkdownPieceEntry>,
  separatesBlocks: boolean,
): JoinedMarkdownPieceEntries {
  const children: ReactNode[] = [];
  const mounts: MountedMessageDirective[] = [];
  const blockMounts: MountedMessageBlock[] = [];
  const tagCounts = new Map<string, number>();
  for (const entry of entries) {
    const reused = reusedEntries.has(entry);
    if (entry.children.length > 0) {
      if (separatesBlocks && children.length > 0) {
        children.push("\n");
      }
      for (const child of entry.children) {
        if (!separatesBlocks && child === "\n") continue;
        children.push(reused ? refreshMarkdownElementTree(child) : child);
      }
    }
    for (const mount of entry.mounts) {
      mounts.push(
        reused ? { ...mount, attributes: { ...mount.attributes } } : mount,
      );
    }
    blockMounts.push(...entry.blockMounts);
    addMarkdownTagCounts(tagCounts, entry.tagCounts);
  }
  return {
    blockMounts:
      blockMounts.length === 0 ? EMPTY_MOUNTED_MESSAGE_BLOCKS : blockMounts,
    children,
    mounts: mounts.length === 0 ? EMPTY_MOUNTED_MESSAGE_DIRECTIVES : mounts,
    tagCounts,
  };
}

function buildResolvedMarkdownPieces(
  entries: readonly MarkdownPieceEntry[],
  previousEntries: readonly MarkdownPieceEntry[],
): ResolvedMarkdownPieces {
  const { blockMounts, children, mounts } = joinMarkdownPieceEntries(
    entries,
    new Set(previousEntries),
    true,
  );
  return { blockMounts, children, mounts };
}

export function createMarkdownPieceCache(): MarkdownPieceCache {
  return {
    config: null,
    entries: [],
    latchedWholeDocumentPrefix: null,
    resolved: null,
  };
}

export function resolveMarkdownPieces(
  cache: MarkdownPieceCache,
  config: MarkdownPieceRenderConfig,
  body: string,
): ResolvedMarkdownPieces {
  if (cache.config !== config) {
    cache.config = config;
    cache.entries = [];
    cache.latchedWholeDocumentPrefix = null;
    cache.resolved = null;
  }
  if (cache.resolved !== null && cache.resolved.body === body) {
    return cache.resolved.result;
  }
  const previousEntries = cache.entries;
  const latchedPrefix = cache.latchedWholeDocumentPrefix;
  const keepsLatchedPrefix =
    latchedPrefix !== null && body.startsWith(latchedPrefix);
  const attemptsPieces = previousEntries.length > 0 && !keepsLatchedPrefix;
  let entries = attemptsPieces
    ? resolveIncrementalMarkdownPieceEntries(
        config,
        body,
        previousEntries,
        TOP_LEVEL_MARKDOWN_PIECE_SCOPE,
      )
    : null;
  if (entries === null) {
    const entry = parseMarkdownPiece({
      capture: null,
      config,
      indexBase: 0,
      offsets: EMPTY_MARKDOWN_TAG_COUNTS,
      source: body,
      sourceOffset: 0,
      topLevel: true,
    });
    entries = [entry];
    cache.latchedWholeDocumentPrefix = keepsLatchedPrefix
      ? latchedPrefix
      : attemptsPieces || entry.summary.hasGlobalConstructs
        ? body
        : null;
  } else {
    cache.latchedWholeDocumentPrefix = null;
  }
  const result = buildResolvedMarkdownPieces(entries, previousEntries);
  cache.entries = entries;
  cache.resolved = { body, result };
  return result;
}
