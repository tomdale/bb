// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
const app = await loadPluginApp(() => import("./app.js"));
afterEach(cleanup);

function assistantMessage(text = "A complete assistant response.") {
  return {
    id: "message_1",
    threadId: "thread_1",
    role: "assistant" as const,
    text,
    sourceSeqEnd: 12,
  };
}

describe("read aloud message action", () => {
  it("registers a per-message assistant response action filtered from user messages", () => {
    expect(app.messageActions).toHaveLength(1);
    expect(app.messageActions[0]).toMatchObject({
      experimental_roles: ["assistant"],
      id: "read-aloud",
      title: "Read response aloud / stop playback",
      icon: "Play",
    });
  });

  it("fetches audio with the response text and stop aborts and releases playback", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchDeferred = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => fetchDeferred),
    );
    const audio = {
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      load: vi.fn(),
      removeAttribute: vi.fn(),
      addEventListener: vi.fn(),
    };
    vi.stubGlobal(
      "Audio",
      class {
        play = audio.play;
        pause = audio.pause;
        load = audio.load;
        removeAttribute = audio.removeAttribute;
        addEventListener = audio.addEventListener;

        constructor(readonly src: string) {
          expect(src).toBe("blob:tts-audio");
        }
      },
    );
    const createObjectURL = vi.fn(() => "blob:tts-audio");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const overlay = renderSlot(app.appOverlays[0]!, {}, { pluginId: "tts" });

    act(() => {
      app.messageActions[0]!.run({
        threadId: "thread_1",
        message: assistantMessage("**Hello** there"),
        openPanel: () => false,
      });
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("/api/v1/plugins/tts/http/speech");
    expect(JSON.parse(String(init?.body))).toEqual({
      threadId: "thread_1",
      text: "Hello there",
    });
    const signal = init?.signal as AbortSignal;

    await act(async () => {
      resolveFetch(
        new Response(new Uint8Array([1, 2]), {
          headers: { "content-type": "audio/mpeg" },
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
    fireEvent.click(
      overlay.getByRole("button", { name: "Stop reading response aloud" }),
    );
    expect(signal.aborted).toBe(true);
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.removeAttribute).toHaveBeenCalledWith("src");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:tts-audio");
    overlay.lifecycle.unmount();
  });

  it("cleans up in-flight playback on unmount", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchDeferred = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => fetchDeferred),
    );
    const overlay = renderSlot(app.appOverlays[0]!, {}, { pluginId: "tts" });
    act(() =>
      app.messageActions[0]!.run({
        threadId: "thread_1",
        message: assistantMessage(),
        openPanel: () => false,
      }),
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const signal = vi.mocked(fetch).mock.calls[0]![1]?.signal as AbortSignal;
    overlay.lifecycle.unmount();
    expect(signal.aborted).toBe(true);
  });
});
