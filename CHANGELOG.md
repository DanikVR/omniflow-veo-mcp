# Changelog

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
