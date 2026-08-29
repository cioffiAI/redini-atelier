# Redini — reins for your AI agent

**Redini** is an open-source Human-in-the-Loop trust layer for [WebMCP](https://webmachinelearning.github.io/webmcp/): it wraps `document.modelContext` so that AI agents can *propose* actions on a web app, and users can *approve, edit, or decline* them — with full undo.

It is demonstrated by **Atelier**, an agent-native design studio where an AI agent edits a flyer and every change goes through a visible approval queue.

> Work in progress — hackathon build (The WebMCP Challenge). See `docs/` for the design documents.

## Quickstart

```bash
npm install
npm run dev
```

Then open the app in ChatGPT's in-app browser (WebMCP is supported out of the box), or in Chrome 149+ with `chrome://flags/#enable-webmcp-testing` enabled.

## What Redini does

- **Approval queue**: mutating tools (`mode: 'approval-required'`) don't execute immediately — they surface in a panel with a human-readable description and Approve / Edit / Decline controls.
- **Read tools run free**: tools declared `mode: 'safe'` (read-only) execute instantly.
- **Undo**: every approved action snapshots the app state first; one click restores it.
- **Activity log**: every agent action is recorded with its outcome.

## License

MIT — see [LICENSE](./LICENSE).
