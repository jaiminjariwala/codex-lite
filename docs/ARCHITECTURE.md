# Architecture

Current default desktop flow, September 2026. Older gateway and operator modules remain in the repository, but the standard chat path uses local Ollama.

## System map

```text
+-------------------------- Your Mac ---------------------------+
| React sidebar                                                |
|  chat | settings | Monaco | file tree | browser chrome         |
|                         | typed IPC                          |
|                 context-isolated preload                     |
|                         |                                    |
| Electron main process                                        |
|  |-- local session / memory storage                          |
|  |-- workspace file IO, revision checks, terminal, Git        |
|  |-- native embedded browser view                            |
|  |-- isolated temporary search windows                       |
|  |-- capture and model routing                               |
|  +-- private Ollama server, loopback port 11435               |
|        |-- qwen2.5-coder:1.5b for text                         |
|        +-- qwen3-vl:2b for image-containing chat              |
+---------------------------|----------------------------------+
                            | HTTPS for account operations
                   +--------v---------+
                   | Go API on Render |
                   +--|------|-----|--+
                      |      |     |
                 GitHub  Supabase    Google
                  OAuth  PostgreSQL  OAuth
```

The browser and search also contact external websites directly from the Mac. Account hosting does not make local model inference a cloud operation.

## Chat and search

```text
user message
  -> access checks and intent routing
  -> ordinary chat: bounded context -> local model -> response
  -> web question: relative-year normalization
       -> Google DOM snippets
       -> DuckDuckGo if blocked, empty, or unavailable
       -> dedicated final-answer prompt with source excerpts
       -> usable sourced response?
            yes -> display
            no  -> one answer retry
                   -> source-link fallback if still unusable
```

Search status is separate from model generation. The search windows are isolated from the user's browsing session and destroyed after use. Search does not solve CAPTCHAs or use screenshots. Extracted text is untrusted data.

The current web-answer step is text-only and focused on the latest question. It does not inspect attached images or resolve every context-dependent follow-up. Relative numeric years are calculated from the current year; this is not a general natural-language date parser.

The answer guard checks for source URLs and planning language. It does not verify factual entailment. Snippets may be incomplete, ambiguous, or misleading.

Search synthesis prefers the installed Qwen3-VL model for its newer language capabilities, even though this step sends text only. It falls back to the text model if Qwen3 is not ready. Numbered references are resolved only against the retrieved source list.

## Model setup

```text
verify local Ollama -> start private process -> check installed models
  -> ensure text model -> text ready
  -> ensure screenshot model -> verify vision capability -> both ready
                               |
                      download error -> Settings retry
                      text stays available if already ready
```

Readiness is actual setup state, not a timer. A failed optional screenshot download must not stop the working text model. The renderer shows a short status label; setup controls live in Settings.

## Workspace layout

React owns the tabs and browser toolbar. Electron owns the native browser page. Menus only hide the native page when their rectangles overlap it, because a native view otherwise covers renderer overlays.

Files selected from the tree reuse the folder's editor tab. Writes use revision checks and a debounce rather than a permanent Save button. Generated snippets still need Save as file because they do not yet have a destination.

Chat text is revealed progressively in the renderer. A DOM observer follows content growth while the reader is near the bottom. Scrolling upward releases follow mode.

## Security boundaries

- Renderer code uses narrow preload APIs, not unrestricted Node access.
- Model downloads and search are network operations even though inference is local.
- Database and GitHub OAuth secrets belong only on the backend.
- Google/GitHub verify identity before Go issues a session. The renderer never receives tokens. Supabase is used only for PostgreSQL hosting.
- Payment routes are removed. Legacy database columns are left unused to preserve existing data.
- Experimental operator tools have their own safety and capability checks.
- Local screenshot support does not enable every visual automation route.

See [backend flow](BACKEND.md), [features](FEATURES.md), and [safety](SAFETY.md).
