import type { RootContent } from "mdast";
import type { JsonValue } from "@get-bb/plugin-sdk";
import type { ExperimentalMessageBlockCodec } from "@get-bb/plugin-sdk/app";

export interface DemoCardSection {
  title: string;
  markdown: string;
}

export interface DemoCard {
  lead: string;
  sections: DemoCardSection[];
}

function plainText(node: RootContent): string {
  if ("value" in node) {
    return node.value;
  }
  if ("children" in node) {
    return node.children.map(plainText).join("");
  }
  return "";
}

function slice(source: string, nodes: readonly RootContent[]): string {
  const start = nodes[0]?.position?.start.offset;
  const end = nodes.at(-1)?.position?.end.offset;
  return start === undefined || end === undefined
    ? ""
    : source.slice(start, end);
}

export function parseDemoCard(
  source: string,
  children: readonly RootContent[],
): DemoCard {
  const leadNodes: RootContent[] = [];
  const sections: { title: string; nodes: RootContent[] }[] = [];
  for (const node of children) {
    if (node.type === "heading") {
      sections.push({ title: plainText(node), nodes: [] });
      continue;
    }
    const current = sections.at(-1);
    if (current === undefined) {
      leadNodes.push(node);
    } else {
      current.nodes.push(node);
    }
  }
  return {
    lead: slice(source, leadNodes),
    sections: sections.map((section) => ({
      title: section.title,
      markdown: slice(source, section.nodes),
    })),
  };
}

export function isDemoCard(value: JsonValue | null): value is DemoCard & {
  [key: string]: JsonValue;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const { lead, sections } = value;
  return (
    typeof lead === "string" &&
    Array.isArray(sections) &&
    sections.every(
      (section) =>
        typeof section === "object" &&
        section !== null &&
        !Array.isArray(section) &&
        typeof section.title === "string" &&
        typeof section.markdown === "string",
    )
  );
}

export const demoCardCodec: ExperimentalMessageBlockCodec = {
  name: "demo-card",
  versions: [1],
  parse({ source, tree }, { status }) {
    const card = parseDemoCard(source, tree.children);
    if (status !== "streaming" && card.sections.length === 0) {
      return { ok: false, error: "a demo card needs at least one heading" };
    }
    return {
      ok: true,
      data: {
        lead: card.lead,
        sections: card.sections.map((section) => ({ ...section })),
      },
    };
  },
  toText(data) {
    if (!isDemoCard(data)) {
      return "";
    }
    return [
      data.lead,
      ...data.sections.map((section) =>
        `${section.title}\n${section.markdown}`.trim(),
      ),
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");
  },
};
