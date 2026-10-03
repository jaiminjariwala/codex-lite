# Backend and account setup

The Go service on Render handles Google and GitHub OAuth, app sessions and account storage. PostgreSQL on Supabase stores accounts. Supabase Auth, SMTP, email codes and SMS are not used. Local Ollama on the Mac handles default AI inference.

## Google browser sign-in

```text
Desktop main process -> Go /v1/auth/google/start
                            |
System browser -> Google account selection -> Go /v1/auth/google/callback
                                                |
                         code exchange + authenticated Google userinfo
                                                |
                               PostgreSQL user keyed by Google subject
                                                |
Desktop encrypted vault <- one-time secret-protected poll <- Go app session
```

Random state and PKCE bind each authorization. A separate random polling secret protects the one-time handoff. Google access tokens are used only on the server to fetch verified identity over HTTPS, then discarded. Neither provider tokens nor app session tokens reach React. Login attempts expire after ten minutes; a server restart cancels pending attempts, not already-issued sessions. Pending attempts are bounded to 1,000 per provider and stored in memory, so this implementation requires one backend instance rather than a load-balanced multi-instance deployment.

Google and GitHub identities are separate accounts, even when the email matches. Google users are keyed by their stable subject, not their email. Previously saved email sessions are preserved until expiry, but email-code endpoints are removed. The chooser lists only accounts authenticated on this Mac. Chats and memory remain shared device-local workspace data; switching accounts does not isolate local chat history.

## Google setup required

1. In Google Cloud Console, create/select your project and open Google Auth Platform.
2. Configure Branding and Audience for external users. While the project is in Testing, add your own account as a test user.
3. Under Clients, create an OAuth client of type **Web application**, because the Go server receives the callback and holds the client secret. Do not use a Desktop client with this server-mediated flow.
4. Add the exact authorized redirect URI: `https://YOUR-BACKEND/v1/auth/google/callback`. Use `http://127.0.0.1:8787/v1/auth/google/callback` only for local development.
5. Set the three Google environment variables below on Render and deploy the updated backend. Never put the client secret in Electron, a screenshot, chat, or Git.
6. Request only `openid email profile`, not Gmail, Drive or other API permissions. Before distributing publicly, switch the audience to production and satisfy Google's applicable consent/branding requirements.
7. Test Google and GitHub login, denial, second-account selection, switching, sign-out and restart persistence. Automated tests use mocked Google responses, not real accounts.

Reference: [Google server-side OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect).

| Backend variable | Purpose |
| --- | --- |
| DATABASE_URL | Private PostgreSQL connection URI |
| SESSION_SECRET | Random secret, at least 32 characters |
| GITHUB_OAUTH_CLIENT_ID | GitHub OAuth public client ID |
| GITHUB_OAUTH_CLIENT_SECRET | GitHub OAuth private client secret |
| GITHUB_OAUTH_REDIRECT_URL | https://YOUR-BACKEND/v1/auth/github/callback |
| GOOGLE_OAUTH_CLIENT_ID | Google Web application client ID |
| GOOGLE_OAUTH_CLIENT_SECRET | Google private client secret, server only |
| GOOGLE_OAUTH_REDIRECT_URL | https://YOUR-BACKEND/v1/auth/google/callback |
| FREE_MONTHLY_UNITS | Optional hosted-AI allowance; does not limit local Ollama |

Use each provider's exact callback URL in its console. Only the Go backend's public URL is embedded in the desktop build. Supabase is used only as PostgreSQL hosting through DATABASE_URL; its Auth configuration is not needed.

## Deployment

Use `backend/Dockerfile` with the backend directory as the build context. Render hosts Go; Supabase hosts PostgreSQL. The database migration allows non-GitHub users to have no GitHub ID. Existing accounts, old payment columns and historical records are preserved, but no active code reads or writes payment data.

Payments, checkout pages, Stripe webhooks and subscription gates have been removed. After deploying this change, remove obsolete Stripe environment variables and disable the old webhook destination in Stripe. These external changes are not made automatically. Previously published desktop binaries still contain their old payment UI, so distribute a newly built version.

## API surface

- Google: POST /v1/auth/google/start, POST /v1/auth/google/poll, GET /v1/auth/google/callback.
- GitHub: POST /v1/auth/github, POST /v1/auth/github/start, POST /v1/auth/github/poll, GET /v1/auth/github/callback.
- Authenticated account: GET /v1/me, GET /v1/usage.
- Optional hosted inference: POST /v1/chat, POST /v1/chat/completions.
- Health: GET /health. Hosted AI readiness is distinct from local model readiness.

Permissions are separate from sign-in. Microphone access is requested only on Allow, not during startup. Accessibility is optional for approved app-control tasks, not required to dictate inside Codex Lite.

App sessions expire after 30 days. Logout removes the selected local session but is not server-wide session revocation. Production work should add distributed abuse controls, persistent OAuth handoffs, session revocation and bot protection as needed.

There are no email/SMS delivery charges in this login flow. Hosting plans retain their own limits and costs; free Render can sleep and delay sign-in after inactivity. Do not promise an always-on service or a production SLA on free infrastructure.
