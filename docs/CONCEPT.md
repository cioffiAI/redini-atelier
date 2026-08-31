# CONCEPT — "Redini" (working name)
> Atelier turns an agent action into an editable ChangeSet. People can preview, amend, cherry-pick, commit and undo changes before the live canvas is mutated.
> Redini is the transaction layer underneath.

Status: DRAFT v0.3, 30/08/2026. Shift in center of gravity: from "consent wrapper" (already a crowded space: @mcptrail/webmcp-consent, WebMCP Text Editor, WebMCP+Legit) to **human-agent negotiation of a multi-operation ChangeSet**.

New central unit:

```text
Agent intent
      ↓
ONE WebMCP call (design_update)
      ↓
ChangeSet — e.g. 5 operations

[✓] setText title → "AI SUMMIT"
[✓] setFill background → #FF0055
[✓] setFont → serif
[ ] move logo → (620, 40)      ← the human excludes it
[✓] resize logo → 120
      ↓
the human can: change the parameters (amend), exclude operations (cherry-pick), see the ghost
      ↓
atomic commit of the subset
      ↓
RECEIPT: INTENDED / AMENDED / SKIPPED BY HUMAN / APPLIED / STATE v→v / UNDO
      ↓
deterministic undo (inverse operations, not snapshots)
```

## 2. Why this claim (and not the old one)

### 2.1 The falsification that forced the pivot
The original claim, "a confirmation wrapper for WebMCP," was verified and **turns out to be already taken**:
- `@mcptrail/webmcp-consent` (npm, v0.1.0): wraps WebMCP registration with an `auto/confirm/deny` policy and an approval modal. **Confirmed to exist** (verified on 29/08/2026).
- The `readOnlyHint` pattern for automatic reads + `confirm()` for writes: already used by existing GUI agents.
- The `annotations.readOnlyHint` flag already exists in the WebMCP spec itself: the safe/mutating distinction on its own is table stakes, not innovation.

### 2.2 The new claim and its defensibility
Approval is only one piece. Redini's unit is the **agentic transaction**:

```
agent intent → proposed mutation → visual preview/diff → human edit → commit → receipt → undo
```

The combination, **live visual collaboration + staged transactions + editable proposal + rollback + audit trail**, is what existing confirmation gates do NOT have:
- **Editable proposal**: the human changes the proposal's parameters before commit (the existing gate only says yes/no).
- **Visual preview/diff**: the proposed change is seen on the real product before it happens (in our case: the flyer before/after), not an abstract modal.
- **Receipts**: every commit produces a structured receipt (id, changes, timestamp, state v→v), traceability at the transaction level, not the log level.
- **Native rollback**: deterministic undo (via inverse operations, no snapshots) is part of the transaction, not an afterthought.
- **Provenance**: complete audit trail of who proposed what, what the human changed in the proposal, and the outcome.

## 3. Honest positioning (NO security theater)

Redini **runs in the page**: a malicious or compromised app can bypass a client-side control. So:
- ❌ We do NOT present Redini as "makes WebMCP secure" or a "security boundary."
- ✅ We present Redini as **human control, recoverability, auditable mutations**: the user sees, decides, corrects and goes back. Real authorization and validation stay server-side (where they belong).
- Added value: Redini also reduces the blast radius of **content injection** (untrusted content that induces the agent into unrequested mutations): the mutation stays an inspectable proposal, it does not automatically become app state. An adversarial case in the demo shows this.

## 4. Design principles

| Principle | Concrete rule |
|---|---|
| Reading is free, mutating is a transaction | Read-only tools (`readOnlyHint`) run immediately; mutations enter staging |
| The human edits the proposal, not just approves it | Every staged transaction is editable in its parameters before commit |
| See it before it happens | Preview of the diff on the real product (before/after) inside the staging card |
| Everything committed has a receipt | Structured receipt: id, changes, timestamp, state v→v |
| Everything committed is reversible | Rollback with one click; the receipt references it in the audit trail |
| The agent never loses the thread | Every proposal gets a structured response (committed / modified / declined), the collaboration continues |

## 5. What the project delivers

1. **`redini/`**: open-source library (~2,100 lines, zero dependencies; the guard core is application-agnostic, the bundled DOM panel is not yet):
   - `registerChangeSetTool()` (with `registerSafeTool()` for read-only)
   - multi-operation ChangeSet: staging, validated per-op amend, cherry-pick, atomic commit of the subset
   - Structured-row receipt: `intended / amended / skippedByHuman / applied` (with the values actually committed)
   - Deterministic undo/redo via **inverse operations** (no snapshot store): editor-style history with `undoStack`/`redoStack`; `undo()`/`redo()` without tokens, every new commit invalidates the redo
   - Provenance audit trail (who proposed what, what the human changed, outcome)
2. **Atelier**: agent-native design studio where the flow is:
   one intent → 3 proposed operations → the human commits one, amends one (amend via typed forms), excludes one → ghost preview on the canvas before commit → 4-section receipt → deterministic undo
3. **An adversarial case**: untrusted vendor content induces the agent to propose an unrequested mutation → Redini shows it stays a staged proposal, the human rejects it with one click.

## 6. Atelier: why it is the right demonstrator

A todo-list or a CRM would make Redini one CRUD demo among thousands. In a **visual editor**:
- Mutations are visible (real diff on the ghost preview, not an abstract description).
- Human-agent collaboration is natural ("make it more minimal" → proposal → correction "blue → green" via per-operation amend).
- The story closes in a single arc: one intent → one multi-op ChangeSet → negotiation → commit of the subset → receipt → undo.
- It is the flagship use case of the WebMCP spec itself (Jen and the flyer): judges recognize it.

## 7. Mapping to the 4 judging criteria (post-pivot estimate)

| Criterion | How Redini satisfies it | Estimate |
|---|---|---|
| WebMCP Leverage | API surface used in v3: registerTool + strict per-kind inputSchema (hand-authored, registered verbatim), readOnlyHint/untrustedContentHint, AbortSignal, blocking execute verified >90s. No dynamic tools/toolchange/declarative form/respondWith in v3: removed, the surface is fixed at 5 tools | 7.5/10 |
| Execution | Atelier as a polished product (not a playground): complete flow with a negotiated ChangeSet | 8/10 (if the polish is careful) |
| Potential Impact | Agentic mutations are the bottleneck of adoption; library reusable by any WebMCP app | 7.5/10 |
| Creativity & Ambition | From 5.5-6/10 with the confirmation-only claim (already taken) to 8-8.5/10 with the "transactional human control" claim: inspect/edit/commit/rollback vs an "Allow?" popup | 8-8.5/10 |

## 8. What you learn (personal goal)

Building a transaction layer forces you to master: tool lifecycle, blocking execute and timeout, the declarative form API (which IS already a native staged transaction: the spec confirms it with `:tool-form-active`), AbortSignal, schema synthesis, and API design with transactional semantics. Plus the discipline of verifying assumptions on real ground (the spike already corrected two assumptions: the JSON-string signature of executeTool, the unbounded wait on promises).

## 9. Success criteria

1. Works in ChatGPT's in-app browser AND in Chrome 149+ (flag), with no console errors.
2. In the video, ONE single continuous scenario < 3 min: initial request ("make the poster more minimal" in one intent) → 3-operation ChangeSet in staging → amend one, skip another, commit the subset → 4-section receipt → the agent receives the structured response and continues → deterministic undo → adversarial case (vendor injection, rejection).
3. The library is copy-paste-able into another project; the README explains the pattern in 30 seconds.
4. Public repo, MIT, distinctive in About.
5. Everything delivered by 22:00 Italian time on September 3. Target: ready on September 2.
