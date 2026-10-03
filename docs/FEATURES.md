# Current feature inventory

This describes the source tree, not a promise that an older published DMG contains every change.

## Chat and personalization

Saved conversations, Markdown, generated-code panels, progressive text reveal, rolling Classic or Coastal ball, light and dark themes, editable local memory, and compact input controls.

Completed history is not intentionally replayed as new generation. The conversation follows growing text while the reader remains near the bottom and lets the reader scroll up.

## Local AI

Qwen Coder handles text/code. Qwen3-VL handles image-containing ordinary chat. Settings contains model-download controls. A short composer label shows progress and readiness without raw registry errors.

A small model can produce incorrect answers. Vision support is not equivalent to general computer-control support.

## Internet search

Explicit search requests and selected freshness heuristics trigger Google-first lookup with DuckDuckGo fallback. Search uses DOM text, not screenshot inference. Numeric relative years are normalized dynamically.

The final-answer stage gets plain source excerpts instead of a raw JSON instruction block. It retries an unusable response once and then provides source links. Citation presence is only a formatting guard, not a fact-check.

When ready, the installed Qwen3 model is preferred for search synthesis. Ordinary text/code chat stays on Qwen Coder. Numbered references are converted to links from the retrieved source list.

The search stage is currently focused on the latest text question. Full-page retrieval, broad semantic query planning, and multimodal web research remain limitations.

## Workspace

Browser, terminal, review, folder and generated-code tabs; right-side file tree; file-type icons; filter; breadcrumbs; tree toggle; same-tab file browsing; debounced autosave with revisions; slim rounded editor scrollbars.

Generated code still uses Save as file to choose a path. Project folders share the current workspace root rather than providing independent multi-root IDE sessions.

## Capture and attachments

Region/window/full-screen shortcuts, screenshot attachments, PDF page rendering, bounded video frames, camera recording and local voice dictation. Permissions, memory use and model capability affect availability.

## Accounts and demo access

Google and GitHub browser sign-in, Go app sessions, PostgreSQL account state, and an encrypted multi-account chooser. First-run microphone and optional Accessibility setup. No email codes, SMS, payments, upgrade screens or subscription access gate.

Signing out removes the active account's saved session token, but remembers its email, name, provider and profile image URL in encrypted local storage. The chooser labels it "Sign in again" and opens that provider's browser authentication. Remembered identities cannot switch into a session without signing in. Other accounts with valid saved sessions remain available. Signing in again replaces the remembered entry rather than creating a duplicate.

## Experimental modules

Operator loops, browser/computer actions, playbooks and container support remain in the source tree. They have separate prerequisites and safety gates and are not advertised as reliable completion of arbitrary tasks.
