# How Codex Lite works

The desktop app is the workspace. Ollama is the local model runner. The Go backend is the account service. PostgreSQL remembers account data.

## Asking a question

The app sends text to Qwen3.5 9B on your Mac for both text and screenshot understanding. Your chats and editable memory are stored locally.

When you ask for internet search, the app retrieves search snippets and asks the local model to answer from them. Searching and answering are separate steps. A successful lookup can still lead to a poor model answer, so the app checks for a sourced final response and retries once. It cannot guarantee correctness.

## Opening code

A folder gets a workspace tab. Selecting a file in the right-side tree replaces the file shown inside that tab. Breadcrumbs show where it lives. Edits autosave with revision checks so an external edit does not silently get overwritten.

Generated code has no path yet, so Save as file asks you where it belongs.

## Signing in

```text
App -> Go server -> GitHub authorization in browser
                       |
                       v
App <- account session <- Go callback
```

The server holds the OAuth client secret. The desktop app does not.

## Google sign-in and account switching

Go creates a short-lived Google browser authorization with state and PKCE. Its callback exchanges the code and reads verified identity directly from Google's authenticated userinfo endpoint. Go issues an app session keyed by Google's stable subject. The desktop retrieves it with a one-time secret-protected poll and stores it in an encrypted vault. The renderer never receives tokens.

There is no checkout or subscription gate. Each Google and GitHub identity is kept separate unless an explicit, verified linking flow is added later. Saved chats and memory remain device-local, not account-isolated cloud data.

## What the cloud is for

Render runs the Go account service. Supabase hosts its PostgreSQL database. They do not run the local Qwen models. The retained cloud-AI API is an optional older path, not the default desktop inference flow.

See [architecture](ARCHITECTURE.md) for details and [setup](SETUP.md) to run it.
