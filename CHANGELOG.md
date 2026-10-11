# Changelog

## 1.3.0 — 2026-10-11

- Google Vids tools: `vids_generate` (create / animate / edit / extend / upscale), `vids_avatar`, `vids_voiceover`, `vids_music`, `vids_export` — a separate monthly pool of seconds.
- Voice-over: start the script with `Female voice:` / `Male voice:` (or `Voice: Holt.`) to pick the voice; brand names are spoken correctly in the script's language.
- Clip QA: `flow_review` returns contact sheets of every clip and seam with measured flags; `flow_redo` re-shoots one scene.
- Final montage in Tesseract (`flow_postprod`, `montage.json`).
- Several extension copies (Chrome profiles): the leader is the copy with a visible project tab.
- Works with the OmniFlow Chrome extension 1.95.0.

## 1.1.2 — 2026-09-05

- Published on npm: `npx -y omniflow-mcp` is back as the primary install command (GitHub install kept as a fallback).
- CI publishes via npm Trusted Publishing (OIDC) with provenance — no npm tokens in the repository.

## 1.1.1 — 2026-09-05

- Bridge no longer dies when the working directory is not writable (e.g. launched from `C:\Windows\System32`): results fall back to `~/omniflow-out`; an explicit `OF_OUT` is never overridden.
- Bridge log messages in English.
- Install straight from GitHub: `npx -y github:DanikVR/omniflow-veo-mcp` (npm package not published yet); Windows note for PowerShell users (`claude.cmd` / `npx.cmd`).
- CI: publish step runs only when an npm token secret exists, so tag pushes stay green without it.

## 1.1.0 — 2026-09-05

First public release of the bridge.

- MCP server (stdio, JSON-RPC 2.0) with five tools: `flow_status`, `flow_generate`, `flow_edit`, `flow_wait`, `flow_cancel`.
- Local HTTP bridge on `127.0.0.1:8787`, token-protected when exposed off-loopback.
- The director playbook now comes from the OmniFlow extension at runtime (`extension.director` in `flow_status`) — the server itself carries no prompt rules and has zero dependencies.
- Claude Code skills `omni-director` and `ad-video`.
- Published on npm as `omniflow-mcp` (`npx -y omniflow-mcp`).
