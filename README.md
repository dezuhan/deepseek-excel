# DeepSeek Excell by dezuhan
![alt text](image.png)

> ## 🔑 BYOK — Bring Your Own Key · 💸 Free · 🧩 Open source
> **Made with DeepSeek V4.1 Flash.**
>
> No subscription, no middleman server, no account on someone else's cloud. You plug in **your own DeepSeek API
> key**, pay DeepSeek directly at their normal rates, and every line of this project is open for you to read,
> fork and change (MIT). The key lives in `.env` on your PC and **never reaches the task pane**.
>
> Free of charge to download and use; the only cost is what your own DeepSeek usage costs.

A **DeepSeek sidebar inside Microsoft Excel 2021**: it reads and edits the spreadsheet you have open — like
Gemini in Google Sheets, but local, BYOK and open source.

- **Nothing changes without your approval.** Every edit is first shown as a **plan card** (sheet, range,
  before → after, cell count); it is written only after you press **Apply**.
- **Undo is built in.** Every applied change is journaled: **Undo last** or **Undo all** from the pane
  (Excel's own Ctrl+Z cannot undo programmatic changes).
- **Cost meter included.** Live balance, peak/off-peak rates and the cost of the current chat.
- **Bilingual UI** EN (default) + ID, and the workbook data stays between your machine, the local server and
  the model call you triggered.

> Inside Excel the name is **“DeepSeek Excel”** (add-in, ribbon button, pane title); **“DeepSeek Excell by
> dezuhan”** is the project/repository name — <https://github.com/dezuhan>

---

## 1. Quick start (one command)

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1     # or: npm run install:app
```

Or simply **double-click `install.cmd`**. The installer does everything: Node check → `npm install` → `.env`
(API key) → icons → React pane build → Excel add-in registration → **hidden autostart**.

Switches: `-ApiKey sk-…`, `-AutoStart`, `-NoAutoStart`, `-StartServer`, `-SkipSideload`, `-SkipBuild`,
`-NonInteractive`, `-Force`.

Then: **close every Excel window → reopen Excel → Home → “DeepSeek Excel” → “DeepSeek Excel”.**

<details>
<summary>Manual steps (what the installer runs)</summary>

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1   # deps + .env (key from DSH credentials or prompt)
npm run assets                                              # Heroicons registry + ribbon PNGs
npm run build:ui                                            # build the React pane into dist/
powershell -ExecutionPolicy Bypass -File scripts\sideload.ps1   # register in Excel (HKCU, no admin)
npm start                                                   # https://localhost:3000
```
</details>

---

## 2. Requirements

| Item | Needed |
|---|---|
| OS | Windows 10/11 (registration uses HKCU; macOS/web not supported) |
| Office | Desktop Excel — 2021 x64 tested (`16.0.16327.20264`) or Microsoft 365 |
| Web engine | Microsoft Edge **WebView2 Runtime** (Evergreen) |
| Runtime | **Node.js ≥ 20** (`npm` is called as `npm.cmd`) |
| Rights | **No administrator rights** — everything is per-user |
| Key | Your own DeepSeek API key (**BYOK**) |

---

## 3. Autostart — hidden, no CMD popup

`install.cmd` enables it automatically (`-NoAutoStart` to skip). The side panel is useless if the local server
is not running, so the server is registered to start by itself at every boot/logon:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1           # install / reinstall
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Status   # check
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Remove   # remove
```

- The logon entry is a `.vbs` launcher in your Startup folder that runs the server with **window style 0**, so
  **no CMD or Node window ever pops up** at boot.
- `scripts\start-server.ps1` does the real work and is **port-guarded**: something already listening on
  `:3000` → it exits instead of starting a second copy.
- ⚠️ Do **not** drop a shortcut to `install.cmd` in the Startup folder — that opens a visible CMD window and
  re-runs the whole installer on every logon. `scripts\autostart.ps1` removes such a shortcut automatically.
- Remove everything (add-in + autostart + cache) with:
  `powershell -ExecutionPolicy Bypass -File scripts\unsideload.ps1 -ClearCache`

---

## 4. Using the sidebar

1. Open any workbook → **Home → DeepSeek Excel**.
2. Ask, for example: *“Create a monthly expense tracker on a new sheet”*, *“Analyze my selection and give five
   insights”*, *“Clean up A1:F30: bold header, thousands separator, autofit”*, *“Build a bar chart from B2:C10
   at H2”*, *“Find ‘Kebutuhan’ and replace it with ‘Pokok’”*.
3. Review the **plan card** diff → **Apply** (or **Cancel**) → **Undo last / Undo all** if needed.

The empty chat offers three one-line suggestions (Analyze selection, Summarize sheet, Clean formatting) that
are **written into the composer** for you to edit — nothing is sent automatically. The header keeps three
buttons: **chat history**, **new chat**, **settings**. Settings is a full page (not a dialog) with **Model**
(key, fetch mode, default model, reasoning effort, cell limits, auto-apply), **Interface** (language,
theme: System/Light/Dark), **Personalize** (base prompt + addable entries, plus “this file only”), **Cost**
and **About**. Chats are stored locally as CouchDB-shaped docs in `store/` and grouped like Recents.

---

## 5. Tools the model can call (24)

- **Read:** `get_workbook_overview`, `read_range`, `get_tables`, `list_charts`, `list_named_ranges`
- **Write:** `write_range`, `write_table_rows`, `format_range`, `clear_range`, `autofit_columns`,
  `insert_rows`, `delete_rows`, `insert_columns`, `delete_columns`, `add_worksheet`, `rename_worksheet`,
  `delete_worksheet`, `sort_range`, `create_table`, `create_chart`, `apply_autofilter`, `conditional_format`,
  `find_replace`, `select_range`

Definitions live in `shared/tools.json` (shared by the pane and the server allowlist).

---

## 6. Configuration — `.env`

`scripts\setup.ps1` writes it (key from `-ApiKey` → `DEEPSEEK_API_KEY` env → `~/.dsh/.credentials.yaml` →
hidden prompt) and restricts its ACL to your user.

| Variable | Default | Meaning |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | **Your own key (BYOK)**; never leaves your machine except in the API call |
| `DEEPSEEK_MODEL` | `deepseek-flash` | default model (e.g. `deepseek-flash`, `deepseek-v4-pro`) |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | OpenAI-compatible endpoint |
| `PORT` | `3000` | local HTTPS port (must match `manifest.xml`) |
| `MAX_CELLS_PER_WRITE` / `_READ` | `5000` / `2000` | per-operation cell caps |
| `MAX_TOOL_ITERATIONS` | `12` | tool steps per turn |
| `MOCK_LLM` | `0` | `1` = mock answers, no DeepSeek calls, no cost |
| `DEBUG_LOG` | `0` | `1` = verbose logs (key always redacted) |

**Reasoning effort** (Settings → Model): Off → `thinking: disabled`; Low/High/Max → `thinking: enabled` +
`reasoning_effort`. Because requests carry `tools`, `reasoning_content` is echoed back on later turns
(the API rejects multi-turn tool chats that drop it).

**Cost meter**: badge in the composer footer (`⛁ 12.34 USD · Off-peak`) → Settings → Cost shows balance
(`/user/balance`), peak status (peak = **01:00–04:00 and 06:00–10:00 UTC, Mon–Fri**; off-peak is half price),
current rates per model and the cost of this chat, computed server-side per request.

---

## 7. How it works

```
Excel 2021 (WebView2)                      Local Node :3000                 api.deepseek.com
┌──────────────────────────┐   HTTPS      ┌────────────────────────┐  HTTPS  ┌───────────────┐
│ dist/ (React + shadcn)   │ ───────────► │ server.js              │ ──────► │ /chat/…       │
│  ui → agent → bridge     │  /api/chat   │  • static + pane token │         │ (SSE stream)  │
│  office-api → Office.js  │ ◄─────────── │  • tool allowlist      │ ◄────── │               │
└──────────────────────────┘   SSE        │  • body/message caps   │         └───────────────┘
        │ Excel.run                       │  • writes .env         │
        ▼                                 └────────────────────────┘
   Active workbook                                  ▲
                                                    │ never sent to the pane
                                              DEEPSEEK_API_KEY (.env)
```

- **The pane owns the agent loop**: it calls the model, executes `tool_calls` through Office.js and feeds
  results back.
- **The server is only a proxy**: it injects the API key, validates tool names, enforces size limits, serves
  assets.
- **Pane token**: regenerated on every server start and served via `/pane-token.js`; any `/api/*` call without
  it is rejected with **401**, so another local process cannot piggyback on your key.
- **Security**: cell contents are **untrusted data** (wrapped in `<sheet_data>`, the system prompt forbids
  following instructions found inside cells); there are no file operations at all — only the active workbook,
  and only after you approve; the distributable ZIP excludes `.env`.

### Limitations

- Excel's own **Ctrl+Z does not undo** programmatic changes — use the pane's Undo buttons.
- Undo is **exact for data**; for structural deletes it is **best effort** (charts/tables/conditional formats
  removed with a sheet do not come back). Ranges over ≈20,000 cells are never snapshotted.
- Formulas are written in en-US syntax with commas (`=SUM(B2:B10)`) so the add-in stays correct on the
  Indonesian locale. Only the active workbook; Windows only.

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| DeepSeek button missing | Close **all** Excel windows and reopen. Still missing: `scripts\sideload.ps1 -Minimal`, then clear `%LOCALAPPDATA%\Microsoft\Office\16.0\Wef\` |
| Task pane blank | `npm run build:ui` then reload. Quick rollback: point `SourceLocation` in `manifest.xml` at `https://localhost:3000/taskpane-classic.html`, run `scripts\sideload.ps1` |
| “Local server unreachable” | Start it (`npm start`) or install `scripts\autostart.ps1` |
| “No DeepSeek API key yet” | Run `scripts\setup.ps1` (BYOK) or paste the key in Settings |
| HTTPS certificate error | Delete `%USERPROFILE%\.office-addin-dev-certs` and run `npm start` again |
| `npm : … cannot be loaded` | `AllSigned` policy blocks `npm.ps1` — use `npm.cmd` (all scripts here already do) |
| WebView2 warning | Install the WebView2 Evergreen Runtime, then `scripts\sideload.ps1 -ForceWebView2` |
| Model refuses to edit | The sheet is protected (Review → Unprotect Sheet) |
| `EALLOWSCRIPTS` from the shadcn CLI | Not needed — the components are already committed in `ui/src/components/ui/` |

---

## 9. Development & tests

```powershell
npm test           # 150 tests (node --test): manifest validation, React+shadcn jsdom smoke test,
                   # i18n contract, assets, validation, SSE, journal/undo, bridge, server contracts
npm run build:ui   # build the React pane into dist/   (watch:ui = rebuild on change)
npm run dev:ui     # Vite dev server (browser only, not Excel)
npm run assets     # regenerate Heroicons barrel + ribbon PNGs
npm run start:mock # server with a mock LLM — no DeepSeek calls, no cost
```

Try the UI without Excel: `npm run start:mock` → open
`https://localhost:3000/taskpane.html?mock=1`. Debug inside Excel:
`powershell -ExecutionPolicy Bypass -File scripts\devtools.ps1 -RuntimeLogging`.

**UI stack:** React 19 + Vite 8 + Tailwind v4 + [shadcn/ui](https://ui.shadcn.com) (Radix UI) with
System/Light/Dark themes. The engine stays vanilla in `public/js/*` (`i18n`, `validate`, `journal`,
`office-api`, `mock-api`, `office-bridge`, `deepseek-client`, `agent`) and is reached through `window.DSX`.
Answers and the composer preview both use **marked** + **DOMPurify** (Ctrl+B/I/E/K shortcuts, copy button on
code blocks, links opened in the system browser).

### Project structure

```
DeepSeek-Excell-by-dezuhan/
├─ install.ps1 / install.cmd   # one-command installer; the wrapper always installs the hidden autostart
├─ manifest.xml                # add-in + ribbon button Home → DeepSeek Excel (minimal fallback included)
├─ server.js                   # HTTPS + static + /api/chat (SSE) + pane token
├─ store.js / api-store.js     # CouchDB-style store + sessions, personalization, cost, pricing APIs
├─ pricing.js                  # peak-hour windows, price merge, per-request cost
├─ shared/tools.json           # 24 tool definitions (English, part of the model API)
├─ shared/pricing.json         # DeepSeek rates + peak windows + effort levels
├─ ui/                         # React + shadcn/ui task pane (Vite)  → built into dist/
├─ public/                     # classic rollback pane, vanilla engine, ribbon icons
├─ scripts/                    # setup, sideload, unsideload, autostart, start-server, devtools, package
└─ test/                       # 150 automated tests (node --test)
```

---

## 10. Credits & license

- **DeepSeek V4.1 Flash** — the model this project is built and tuned with (`deepseek-flash` by default).
- **[Heroicons](https://heroicons.com)** v2.2.0 (MIT) — icon pack; ribbon PNGs are rasterized from
  `24/solid/table-cells.svg`.
- **[shadcn/ui](https://ui.shadcn.com)** + **[Radix UI](https://www.radix-ui.com)** +
  **[Tailwind CSS](https://tailwindcss.com)** v4 (all MIT).
- **[marked](https://marked.js.org)** (MIT) and **[DOMPurify](https://github.com/cure53/DOMPurify)**
  (Apache-2.0 OR MPL-2.0) for Markdown + sanitization.

This project is **free and open source under the MIT license** — see [`LICENSE`](LICENSE),
© 2026 Dzuhan Ramadhan. Bring your own key, keep your data, change the code.
