# Technology choices

| Component | Technology | Role |
| --- | --- | --- |
| Desktop | Electron 43 | Native windows, capture, isolated browser views and IPC |
| Interface | React 18 and TypeScript 5 | Chat, settings and workspace state |
| Editor | Monaco | Highlighting, file editing, breadcrumbs integration |
| Build | electron-vite 5, Vite 7, electron-builder | Development, bundles and macOS packaging |
| Local models | Ollama, Qwen3.5 9B | Text/code and screenshot inference on the Mac |
| Model protocol | OpenAI-compatible SDK | Calls the private local inference endpoint |
| Search | Isolated Electron browser windows | Google-first DOM snippets with DuckDuckGo fallback |
| Speech | Transformers.js and Whisper | On-device dictation |
| Attachments | PDF.js, MediaRecorder, canvas | PDF pages and bounded video-frame context |
| Account API | Go | Google/GitHub OAuth and app sessions |
| Database | PostgreSQL on Supabase | Server-side account state |
| Backend hosting | Render | Runs the Go container separately from the database |
| Identity | Google and GitHub | Browser authorization and verified provider identity |
| Tests | Vitest, fast-check, Playwright smoke fixtures | Unit, property and UI checks |

Playwright, Docker/Colima and macOS input adapters also remain for experimental operator workflows. They are not needed for plain local chat or the DOM-snippet search path.

The default chat client routes to local Ollama. Retained hosted-provider code should not be confused with the default product behavior. See [architecture](ARCHITECTURE.md).
