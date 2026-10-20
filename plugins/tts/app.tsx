import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { ThreadChatMessageReference } from "@get-bb/plugin-sdk/app";
import { extractSpeechText } from "./tts.js";

const MAX_ERROR_LENGTH = 240;
const playListeners = new Set<(message: ThreadChatMessageReference) => void>();

export function requestReadAloud(message: ThreadChatMessageReference): void {
  for (const listener of playListeners) listener(message);
}

type ActivePlayback = {
  messageId: string;
  controller: AbortController;
  audio: HTMLAudioElement | null;
  objectUrl: string | null;
};

function errorFromResponse(response: Response): Promise<string> {
  return response
    .json()
    .then((body: unknown) => {
      if (
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "string"
      ) {
        return body.error.slice(0, MAX_ERROR_LENGTH);
      }
      return `Speech request failed (${response.status}).`;
    })
    .catch(() => `Speech request failed (${response.status}).`);
}

function ReadAloudAction() {
  const pluginId = "tts";
  const activeRef = useRef<ActivePlayback | null>(null);
  const [active, setActive] = useState<{
    messageId: string;
    state: "loading" | "playing";
  } | null>(null);
  const [error, setError] = useState("");

  const stop = useCallback(() => {
    const playback = activeRef.current;
    if (playback === null) return;
    activeRef.current = null;
    playback.controller.abort();
    playback.audio?.pause();
    if (playback.audio !== null) {
      playback.audio.removeAttribute("src");
      playback.audio.load();
    }
    if (playback.objectUrl !== null) URL.revokeObjectURL(playback.objectUrl);
    setActive(null);
  }, []);

  const play = useCallback(
    async (message: ThreadChatMessageReference) => {
      const previous = activeRef.current;
      if (previous?.messageId === message.id) {
        stop();
        return;
      }
      stop();
      const text = extractSpeechText(message.text);
      if (text.length === 0) {
        setError("This response has no readable text.");
        return;
      }
      const controller = new AbortController();
      const playback: ActivePlayback = {
        messageId: message.id,
        controller,
        audio: null,
        objectUrl: null,
      };
      activeRef.current = playback;
      setError("");
      setActive({ messageId: message.id, state: "loading" });
      try {
        const response = await fetch(
          `/api/v1/plugins/${encodeURIComponent(pluginId)}/http/speech`,
          {
            method: "POST",
            signal: controller.signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ threadId: message.threadId, text }),
          },
        );
        if (!response.ok) throw new Error(await errorFromResponse(response));
        const blob = await response.blob();
        if (activeRef.current !== playback || controller.signal.aborted) return;
        const objectUrl = URL.createObjectURL(blob);
        const audio = new Audio(objectUrl);
        playback.objectUrl = objectUrl;
        playback.audio = audio;
        audio.addEventListener(
          "ended",
          () => {
            if (activeRef.current === playback) stop();
          },
          { once: true },
        );
        audio.addEventListener(
          "error",
          () => {
            if (activeRef.current === playback) {
              setError("The generated audio could not be played.");
              stop();
            }
          },
          { once: true },
        );
        await audio.play();
        if (activeRef.current === playback) {
          setActive({ messageId: message.id, state: "playing" });
        }
      } catch (cause) {
        if (controller.signal.aborted || activeRef.current !== playback) return;
        setError(
          cause instanceof Error ? cause.message : "Speech generation failed.",
        );
        stop();
        setError(
          cause instanceof Error ? cause.message : "Speech generation failed.",
        );
      }
    },
    [pluginId, stop],
  );

  useEffect(() => {
    const onPlayRequest = (message: ThreadChatMessageReference) =>
      void play(message);
    playListeners.add(onPlayRequest);
    return () => {
      playListeners.delete(onPlayRequest);
    };
  }, [play]);

  useEffect(
    () => () => {
      const playback = activeRef.current;
      if (playback === null) return;
      activeRef.current = null;
      playback.controller.abort();
      playback.audio?.pause();
      if (playback.audio !== null) {
        playback.audio.removeAttribute("src");
        playback.audio.load();
      }
      if (playback.objectUrl !== null) URL.revokeObjectURL(playback.objectUrl);
    },
    [],
  );

  if (active === null && error.length === 0) return null;
  return (
    <div
      role={error.length > 0 ? "alert" : "status"}
      aria-live={error.length > 0 ? "assertive" : "polite"}
      className="fixed bottom-4 right-4 z-50 flex max-w-sm items-center gap-3 rounded-lg border border-border bg-background p-3 text-sm text-foreground shadow-lg"
    >
      {error.length > 0 ? (
        <span>{error}</span>
      ) : (
        <span>
          {active?.state === "loading"
            ? "Preparing response audio…"
            : "Reading response aloud"}
        </span>
      )}
      {active !== null ? (
        <button
          type="button"
          className="shrink-0 rounded-md border border-border px-2 py-1 font-medium hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="Stop reading response aloud"
          onClick={stop}
        >
          Stop
        </button>
      ) : (
        <button
          type="button"
          className="shrink-0 rounded-md border border-border px-2 py-1 font-medium hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => setError("")}
        >
          Dismiss
        </button>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.messageAction({
    id: "read-aloud",
    title: "Read response aloud / stop playback",
    icon: "Play",
    experimental_roles: ["assistant"],
    run({ message }) {
      if (message.role !== "assistant") return;
      requestReadAloud(message);
    },
  });
  app.slots.experimental_appOverlay({
    id: "playback",
    component: ReadAloudAction,
  });
});
