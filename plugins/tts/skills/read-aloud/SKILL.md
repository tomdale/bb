---
name: read-aloud
description:
  Configure and use the BB Read aloud plugin for speaking individual assistant
  responses.
---

# Read aloud

Use the **Read response aloud / stop playback** action on an assistant response.
An inline player appears beneath the message while speech is prepared and
played. It shows live audio levels and progress, and provides pause, resume, and
stop controls. Activating the same response action again also stops playback. A
floating player is used if the message's timeline row is unavailable.

Install from the repository root with `bb plugin install ./plugins/tts`.

Set `AI_GATEWAY_API_KEY` in Settings → Environment variables (globally or for
the project). Read aloud uses the thread's project value, falling back to the
global value. Optionally set **Vercel AI Gateway API key override** in Settings
→ Installed plugins → Read aloud; a non-empty plugin secret setting overrides
the environment value for all threads. BB scope precedence means a project
value, including an empty value, overrides global. Read aloud treats an
effective empty/whitespace-only key as unconfigured and returns HTTP 503, while
a whitespace-only plugin override falls through to BB environment values. Reload
with `bb plugin reload tts` after initial global configuration so
needs-configuration status updates. Project-only keys are resolved per thread
and do not affect plugin-wide status.

The plugin uses a restricted experimental server accessor that resolves the
requested thread on the server and reads only `AI_GATEWAY_API_KEY` for that
thread's project, then global scope. On older runtimes without that accessor, it
checks the thread through `bb.sdk.threads.get` and can use the plugin override
but cannot read BB Environment variables. The manifest SDK floor does not
guarantee this experimental method: use a matching BB server checkout/release. A
`bb plugin dev ./plugins/tts` loop rebuilds/reloads the local path plugin but
cannot add the API to an unrelated installed server binary.

BB's current local server is single-owner. Plugin HTTP `local` auth validates
local/trusted Origin and JSON mutation content type, not per-user or per-project
membership. `requirePublicThread` proves existence and non-deletion, not
caller-specific project access. Anyone able to call this local plugin route can
request speech using any existing thread's project key. Do not expose it to
untrusted users or a public proxy. BB plugins are trusted server-side code.
Never return the key to a client or log it.

The plugin sends extracted assistant response text to Vercel AI Gateway's speech
endpoint using `openai/tts-1`, voice `alloy`, and MP3 output. It excludes
separate tool-output cards, reads Markdown as prose, limits text to 4,000
characters, and limits each phrase request to 360 characters. The Gateway
returns complete base64 audio JSON; its documented REST endpoint does not stream
audio. Read aloud starts after the first phrase is synthesized and fetches a
following phrase ahead while playback runs, which can reduce perceived latency
and gaps but cannot stream within a phrase. Hovering over the player shows the
measured time to first playback. Speech requires an available Gateway
account/model. Gateway errors appear in the player; generated speech is not
cached.
