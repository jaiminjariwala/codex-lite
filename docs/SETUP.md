# Setup

This guide describes the current local-model desktop build.

## Desktop

1. Use macOS and a Node version supported by Vite 7, such as Node 22.12 or newer in that release line.
2. Install dependencies with `npm install`.
3. Create an ignored `.env.local` with `MANAGED_BACKEND_URL=https://YOUR-BACKEND`.
4. Run `npm run dev`.
5. Sign in with Google or GitHub through the configured backend. See [OAuth setup](BACKEND.md).
6. Choose your account and allow or skip microphone and optional Accessibility setup.
7. Open Settings to inspect local model setup.

The app prepares a private Ollama server and downloads Qwen3.5 9B when missing. Allow several gigabytes of network transfer and at least 7 GB free disk space for setup. Download speed depends on your connection and the model registry.

Text can work once its model is installed, even if the vision download later fails. Use Resume / retry in Settings for interrupted setup. The status below the input reports progress and only reports both models ready when setup has completed.

## Permissions

Screen capture needs macOS Screen Recording permission. Dictation needs Microphone; camera capture needs Camera. Experimental computer control additionally needs Accessibility.

Grant permissions in System Settings, Privacy & Security. Do not disable system protections just to run an untrusted binary. Distribution signing and notarization need separate verification.

## Backend

Follow [the backend guide](BACKEND.md). Keep secrets in backend environment configuration, never in Electron or source control.

Do not create a second PostgreSQL database on Render if you are already using Supabase. The app only embeds the backend's public URL.

## Verification

```bash
npm run typecheck
npm test
npm run build
node scripts/smoke-workspace.mjs
node scripts/smoke-web-search.cjs "a question to search"
```

The workspace smoke test uses fake IPC and Chrome. The search smoke test makes real public network requests through Electron, but does not itself validate a model answer.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Google sign-in unavailable | Backend Google OAuth client ID/secret and exact callback URL. |
| Google refuses access | OAuth consent audience, test users and redirect URI configuration. |
| Model download failed | Retry in Settings; check connectivity and available storage. |
| Searching finishes without a useful answer | Snippet relevance and local model quality. Try an explicit date or open the source links. |
| Screenshot question fails | Vision download and capability verification must finish. |
| Login is slow after inactivity | The hosted account service may need to wake up. |

Older provider configuration and container-operator guides describe optional or legacy paths, not the standard first-run experience.
