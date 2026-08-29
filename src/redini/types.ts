/**
 * Redini — the Human-in-the-Loop trust layer for WebMCP.
 *
 * Day-1 scaffold: type contract only. Implementation lands Day 2.
 * Design doc: docs/TECHNICAL-DESIGN.md §3.
 */

export type ToolMode = 'safe' | 'approval-required';

export type ToolOutcome = 'approved' | 'declined' | 'modified' | 'undone';

/** A tool registered through Redini instead of raw document.modelContext. */
export interface GuardedToolDefinition {
  /** WebMCP tool name (1-128 chars, ASCII alphanumeric, '_', '-', '.'). */
  name: string;
  /** Natural-language description read by the agent. */
  description: string;
  /** JSON Schema for the input parameters. */
  inputSchema?: object;
  /** Read-only tools run immediately; mutating tools enter the approval queue. */
  mode: ToolMode;
  /**
   * Human-facing one-liner describing what the action will do,
   * shown in the approval card. Example: `Set the title to "X"`.
   */
  describe?: (input: Record<string, unknown>) => string;
  /** The actual client-side logic, executed only per policy. */
  execute: (input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown> | unknown;
}

/** A pending request in the approval queue. */
export interface ApprovalRequest {
  id: number;
  tool: GuardedToolDefinition;
  input: Record<string, unknown>;
  humanDescription: string;
  createdAt: number;
  resolve: (decision: ApprovalDecision) => void;
}

export type ApprovalDecision =
  | { outcome: 'approved' }
  | { outcome: 'declined'; reason?: string }
  | { outcome: 'modified'; input: Record<string, unknown> };
