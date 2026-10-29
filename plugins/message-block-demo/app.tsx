import { useState } from "react";
import {
  definePluginApp,
  Markdown,
  type ExperimentalMessageBlockProps,
} from "@get-bb/plugin-sdk/app";
import { CONTEXT_CARD_CLASS } from "@/components/ui/chrome-style-tokens";
import { cn } from "@/lib/utils";
import { demoCardCodec, isDemoCard } from "./card.js";

const STATUS_LABELS: Record<ExperimentalMessageBlockProps["status"], string> =
  {
    closed: "Complete",
    streaming: "Writing…",
    unclosed: "Unfinished",
  };

export function DemoCardBlock({
  data,
  status,
  Original,
}: ExperimentalMessageBlockProps) {
  const [showSource, setShowSource] = useState(false);
  const card = isDemoCard(data) ? data : null;
  return (
    <section
      className={cn("my-2 overflow-hidden", CONTEXT_CARD_CLASS)}
      data-demo-card-status={status}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <span>demo-card</span>
        <span className="flex items-center gap-2">
          <span>{STATUS_LABELS[status]}</span>
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            aria-pressed={showSource}
            onClick={() => setShowSource((value) => !value)}
          >
            {showSource ? "Card" : "Source"}
          </button>
        </span>
      </header>
      <div className="space-y-3 px-3 py-2">
        {showSource ? (
          <Original />
        ) : card === null ? (
          <p className="text-sm text-muted-foreground">Waiting for content…</p>
        ) : (
          <>
            {card.lead.length > 0 ? <Markdown content={card.lead} /> : null}
            {card.sections.map((section, index) => (
              <div key={`${index}-${section.title}`}>
                <h4 className="text-xs font-semibold uppercase text-muted-foreground">
                  {section.title}
                </h4>
                {section.markdown.length > 0 ? (
                  <Markdown content={section.markdown} />
                ) : null}
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_messageBlock({
    ...demoCardCodec,
    component: DemoCardBlock,
  });
});
