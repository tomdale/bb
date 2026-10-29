import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { PluginMessageDirectiveMessage } from "@get-bb/plugin-sdk";
import type { MarkdownMessageDirectives } from "./markdown-message-directives";
import {
  CodeFenceRendererHost,
  useCodeFenceLanguages,
} from "./markdown-code-fence-renderers";

interface MessageMarkdownContextValue {
  directives: MarkdownMessageDirectives | undefined;
  message: PluginMessageDirectiveMessage;
  textComplete: boolean;
}

export const MessageMarkdownContext =
  createContext<MessageMarkdownContextValue | null>(null);

export function MessageBlockMarkdown({
  children,
  inheritMessage,
}: {
  children: (directives: MarkdownMessageDirectives | undefined) => ReactNode;
  inheritMessage: boolean;
}) {
  const inheritedMessage = useContext(MessageMarkdownContext);
  const messageContext = inheritMessage ? inheritedMessage : null;
  const fenceRegistry = useCodeFenceLanguages();
  const directives = useMemo(() => {
    const inherited = messageContext?.directives;
    if (inherited === undefined) return undefined;
    return {
      ...inherited,
      registry: new Map(
        [...inherited.registry].filter(
          ([, entry]) => entry.status !== "ok" || entry.kind !== "block",
        ),
      ),
    };
  }, [messageContext?.directives]);
  const preview = children(directives);
  return (
    <MessageMarkdownContext.Provider value={null}>
      {messageContext === null || fenceRegistry === null ? (
        preview
      ) : (
        <CodeFenceRendererHost
          registry={fenceRegistry}
          message={messageContext.message}
          textComplete={messageContext.textComplete}
        >
          {preview}
        </CodeFenceRendererHost>
      )}
    </MessageMarkdownContext.Provider>
  );
}
