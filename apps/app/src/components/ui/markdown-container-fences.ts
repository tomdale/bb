import { trimMarkdownLineCarriageReturn } from "./markdown-prompt-blockquote-boundaries.js";

export interface MarkdownContainerFence {
  size: number;
}

export interface MarkdownContainerExtent {
  closer: string | null;
  end: number;
  fence: MarkdownContainerFence;
  innerEnd: number;
  innerStart: number;
  opener: string;
}

const CONTAINER_NAME_SOURCE = String.raw`[^\s\p{P}\p{S}][^\s\p{P}\p{S}\-_]*(?:[-_]+[^\s\p{P}\p{S}\-_]+)*`;
const CONTAINER_OPEN_TAIL_SOURCE = String.raw`(?:\[.*\])?(?:\{.*\})?[ \t]*$`;
const CONTAINER_OPEN_PATTERN = new RegExp(
  String.raw`^ {0,3}(:{3,})${CONTAINER_NAME_SOURCE}${CONTAINER_OPEN_TAIL_SOURCE}`,
  "u",
);
const ANY_INDENT_CONTAINER_OPEN_PATTERN = new RegExp(
  String.raw`^\s*(:{3,})${CONTAINER_NAME_SOURCE}${CONTAINER_OPEN_TAIL_SOURCE}`,
  "u",
);
const CONTAINER_CLOSE_PATTERN = /^ {0,3}(:{3,})[ \t]*$/u;
const ANY_INDENT_CONTAINER_CLOSE_PATTERN = /^\s*(:{3,})\s*$/u;

function fenceFrom(
  match: RegExpExecArray | null,
): MarkdownContainerFence | null {
  const sequence = match?.[1];
  return sequence === undefined ? null : { size: sequence.length };
}

export function parseMarkdownContainerOpen(
  line: string,
): MarkdownContainerFence | null {
  return fenceFrom(
    CONTAINER_OPEN_PATTERN.exec(trimMarkdownLineCarriageReturn(line)),
  );
}

export function parseAnyIndentMarkdownContainerOpen(
  line: string,
): MarkdownContainerFence | null {
  return fenceFrom(
    ANY_INDENT_CONTAINER_OPEN_PATTERN.exec(
      trimMarkdownLineCarriageReturn(line),
    ),
  );
}

export function closesMarkdownContainer(
  line: string,
  fence: MarkdownContainerFence,
): boolean {
  const size = CONTAINER_CLOSE_PATTERN.exec(
    trimMarkdownLineCarriageReturn(line),
  )?.[1]?.length;
  return size !== undefined && size >= fence.size;
}

export function closesAnyIndentMarkdownContainer(
  line: string,
  fence: MarkdownContainerFence,
): boolean {
  const size = ANY_INDENT_CONTAINER_CLOSE_PATTERN.exec(
    trimMarkdownLineCarriageReturn(line),
  )?.[1]?.length;
  return size !== undefined && size >= fence.size;
}

export function findMarkdownContainerExtent(
  body: string,
  start: number,
): MarkdownContainerExtent | null {
  const openerNewline = body.indexOf("\n", start);
  const openerEnd = openerNewline === -1 ? body.length : openerNewline;
  const opener = trimMarkdownLineCarriageReturn(body.slice(start, openerEnd));
  const fence = parseMarkdownContainerOpen(opener);
  if (fence === null) {
    return null;
  }
  if (openerNewline === -1) {
    return {
      closer: null,
      end: body.length,
      fence,
      innerEnd: body.length,
      innerStart: body.length,
      opener,
    };
  }
  const innerStart = openerNewline + 1;
  let lineStart = innerStart;
  while (lineStart < body.length) {
    const newline = body.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? body.length : newline;
    const line = body.slice(lineStart, lineEnd);
    if (closesMarkdownContainer(line, fence)) {
      return {
        closer: trimMarkdownLineCarriageReturn(line).trim(),
        end: newline === -1 ? body.length : newline + 1,
        fence,
        innerEnd: lineStart,
        innerStart,
        opener,
      };
    }
    lineStart = newline === -1 ? body.length : newline + 1;
  }
  return {
    closer: null,
    end: body.length,
    fence,
    innerEnd: body.length,
    innerStart,
    opener,
  };
}
