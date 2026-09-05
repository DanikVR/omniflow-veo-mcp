# Contributing

Thanks for looking. A few practical notes before you open a PR.

- **What lives here:** the MCP server, the local bridge, the Claude skills and the docs. The Chrome extension that drives Google Flow is a separate, closed product — issues about it are welcome here too, fixes ship through the Chrome Web Store.
- **No dependencies, on purpose.** The bridge runs on Node 20 built-ins only so `npx omniflow-mcp` starts instantly on any machine. Please keep it that way.
- **stdout is the protocol.** In `bridge/mcp.mjs` anything you log must go to `stderr` (`log(...)`), or the MCP client receives garbage instead of JSON-RPC.
- **Check before pushing:** `npm run check`, then a real session — `claude mcp add omniflow -- node bridge/mcp.mjs`, `flow_status`, one small `flow_generate`.
- **Language.** Code, comments and docs in English. Skill bodies are in Russian for now; English translations are very welcome as a PR.
- **Bugs about Google Flow itself** (a button moved, a dialog changed) — please attach the Flow page language and a screenshot; the extension finds controls by visible text, so the exact wording matters.

Questions: [t.me/GuruAppSheet](https://t.me/GuruAppSheet).
