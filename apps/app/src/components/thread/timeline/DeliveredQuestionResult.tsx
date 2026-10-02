import { z } from "zod";

const deliveredQuestionSchema = z.object({
  question: z.string().min(1).max(4096),
  header: z.string().min(1).max(256).optional(),
  options: z
    .array(
      z.object({
        label: z.string().min(1).max(256),
        description: z.string().max(4096).optional(),
      }),
    )
    .max(4)
    .optional(),
  multiSelect: z.boolean().optional(),
});

const deliveredQuestionResultSchema = z.object({
  questions: z.array(deliveredQuestionSchema).min(1).max(4),
  answers: z.record(z.string().max(4096), z.string().max(4096)),
});

type DeliveredQuestionResultData = z.infer<
  typeof deliveredQuestionResultSchema
>;

const RESULT_LEAD =
  /^Your earlier AskUserQuestion tool call has finished\. Its result:\s*/u;

export function parseDeliveredQuestionResult(
  text: string,
): DeliveredQuestionResultData | null {
  const match = RESULT_LEAD.exec(text);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(match[0].length));
    const result = deliveredQuestionResultSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function deliveredQuestionResultPreview(
  result: DeliveredQuestionResultData,
): string {
  const firstQuestion = result.questions[0];
  if (!firstQuestion) return `${result.questions.length} questions answered`;
  const answer = result.answers[firstQuestion.question];
  return answer
    ? `${firstQuestion.question} — ${answer}`
    : `${result.questions.length} questions answered`;
}

export function DeliveredQuestionResult({
  result,
  rawText,
}: {
  result: DeliveredQuestionResultData;
  rawText: string;
}) {
  return (
    <div
      className="overflow-hidden rounded-lg border border-border bg-card px-3 py-2.5 text-foreground"
      data-testid="delivered-question-result"
    >
      <div className="mb-2 text-xs font-semibold text-muted-foreground">
        {result.questions.length}{" "}
        {result.questions.length === 1 ? "question" : "questions"} answered
      </div>
      <ul className="space-y-2.5">
        {result.questions.map((question) => {
          const answer = result.answers[question.question];
          return (
            <li key={question.question}>
              <div className="text-xs text-muted-foreground">
                {question.question}
              </div>
              <div className="mt-0.5 whitespace-pre-wrap text-sm">
                {answer || (
                  <span className="text-muted-foreground">No answer</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <details className="mt-2 border-t border-border pt-1.5 text-xs text-muted-foreground">
        <summary className="w-fit cursor-pointer">Tool details</summary>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono">
          {rawText}
        </pre>
      </details>
    </div>
  );
}
