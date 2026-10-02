import { z } from "zod";
import { MarkdownPreview } from "@/components/ui/markdown-preview.js";
import type { TimelineToolArgs } from "@bb/server-contract";
import type { ThreadTimelineLocalFileLinkHandler } from "./types.js";

const recapItemSchema = z.union([
  z.string().max(4096),
  z
    .object({
      step: z.string().max(4096),
      expect: z.string().max(4096).optional(),
    })
    .strict(),
]);

const recapSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("complete"),
      goal: z.string().max(4096),
      latest: z.array(recapItemSchema).max(3).min(1),
    })
    .passthrough(),
  z
    .object({
      state: z.literal("review"),
      goal: z.string().max(4096),
      latest: z.array(recapItemSchema).max(3).min(1),
      review: z.union([z.array(recapItemSchema).max(3), z.string().max(4096)]),
      links: z
        .array(
          z.object({
            title: z.string().max(256),
            location: z
              .string()
              .max(2048)
              .refine(
                (value) =>
                  value.startsWith("https://") ||
                  (value.startsWith("/") && !value.startsWith("//")),
                "Use an HTTPS URL or absolute local path",
              ),
          }),
        )
        .max(8)
        .optional(),
    })
    .passthrough(),
  z
    .object({
      state: z.literal("waiting"),
      goal: z.string().max(4096),
      tasks: z.array(recapItemSchema).max(3).min(1),
      timeout: z.number().int().positive().optional(),
    })
    .passthrough(),
]);

type Recap = z.infer<typeof recapSchema>;
type RecapItem = z.infer<typeof recapItemSchema>;

const STATE_LABEL: Record<Recap["state"], string> = {
  complete: "Complete",
  review: "Ready for review",
  waiting: "Waiting",
};

const STATE_BADGE_CLASS: Record<Recap["state"], string> = {
  complete: "text-emerald-700 dark:text-emerald-300",
  review: "text-sky-700 dark:text-sky-300",
  waiting: "text-violet-700 dark:text-violet-300",
};

function parseRecap(args: TimelineToolArgs): Recap | null {
  const parsed = recapSchema.safeParse(args);
  if (!parsed.success || !parsed.data.goal.trim()) return null;
  if (parsed.data.state === "waiting") {
    return parsed.data.tasks.length > 0 ? parsed.data : null;
  }
  return parsed.data.latest.length > 0 ? parsed.data : null;
}

function itemParts(item: RecapItem): { step: string; expect?: string } {
  return typeof item === "string" ? { step: item } : item;
}

function RecapItems({ items }: { items: RecapItem[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((item, index) => {
        const { step, expect } = itemParts(item);
        return (
          <li key={`${index}:${step}`} className="flex min-w-0 gap-2">
            <span className="shrink-0 text-muted-foreground" aria-hidden="true">
              –
            </span>
            <div className="min-w-0 flex-1">
              <MarkdownPreview
                content={step}
                className="text-xs leading-relaxed"
                imagePolicy="alt-text"
              />
              {expect ? (
                <MarkdownPreview
                  content={expect}
                  className="mt-0.5 text-xs leading-relaxed text-muted-foreground"
                  imagePolicy="alt-text"
                />
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function reviewItems(recap: Extract<Recap, { state: "review" }>): RecapItem[] {
  if (Array.isArray(recap.review)) return recap.review;
  try {
    const parsed: unknown = JSON.parse(recap.review);
    const result = z.array(recapItemSchema).max(3).safeParse(parsed);
    return result.success ? result.data : [recap.review];
  } catch {
    return [recap.review];
  }
}

function ReviewLinks({
  links,
  onOpenLocalFileLink,
}: {
  links: { title: string; location: string }[];
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
}) {
  const safeLinks = links.filter(
    (link) =>
      link.location.startsWith("https://") ||
      (link.location.startsWith("/") && !link.location.startsWith("//")),
  );
  if (safeLinks.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border pt-2 text-xs">
      {safeLinks.map((link) =>
        link.location.startsWith("https://") ? (
          <a
            key={`${link.title}:${link.location}`}
            href={link.location}
            className="underline underline-offset-2"
            title={link.location}
          >
            {link.title}
          </a>
        ) : (
          <button
            key={`${link.title}:${link.location}`}
            type="button"
            onClick={() => {
              if (!onOpenLocalFileLink) return;
              onOpenLocalFileLink({ path: link.location, lineRange: null });
            }}
            disabled={!onOpenLocalFileLink}
            className="underline underline-offset-2 disabled:cursor-default disabled:no-underline"
            title={link.location}
          >
            {link.title}
          </button>
        ),
      )}
    </div>
  );
}

export function parseRecapToolArgs(args: TimelineToolArgs): Recap | null {
  return parseRecap(args);
}

export function RecapToolOutput({
  args,
  output,
  onOpenLocalFileLink,
}: {
  args: TimelineToolArgs;
  output: string;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
}) {
  const recap = parseRecap(args);
  if (!recap) return null;
  const items = recap.state === "waiting" ? recap.tasks : recap.latest;
  const reviews = recap.state === "review" ? reviewItems(recap) : [];

  return (
    <div
      className="overflow-hidden rounded-lg border border-border bg-card px-3 py-2.5 text-foreground"
      data-testid="recap-tool-output"
    >
      <div
        className={`text-xs font-semibold uppercase tracking-wide ${STATE_BADGE_CLASS[recap.state]}`}
      >
        {STATE_LABEL[recap.state]}
      </div>
      <MarkdownPreview
        content={recap.goal}
        className="mt-0.5 text-sm font-medium leading-snug"
        imagePolicy="alt-text"
      />
      <div className="mt-2 space-y-2">
        <RecapItems items={items} />
        {reviews.length > 0 ? (
          <div className="border-t border-border pt-2">
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              Review
            </div>
            <RecapItems items={reviews} />
          </div>
        ) : null}
        {recap.state === "waiting" && recap.timeout !== undefined ? (
          <div className="text-xs text-muted-foreground">
            Check status in {recap.timeout}s
          </div>
        ) : null}
        {recap.state === "review" && recap.links?.length ? (
          <ReviewLinks
            links={recap.links}
            onOpenLocalFileLink={onOpenLocalFileLink}
          />
        ) : null}
      </div>
      <details className="mt-2 border-t border-border pt-1.5 text-xs text-muted-foreground">
        <summary className="w-fit cursor-pointer">Tool details</summary>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono">
          {JSON.stringify(args, null, 2)}
          {output ? `\n\n${output}` : ""}
        </pre>
      </details>
    </div>
  );
}
