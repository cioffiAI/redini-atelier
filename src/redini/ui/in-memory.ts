import type {
  AuditEntry,
  ChangeSet,
  ChangeSetReceipt,
  PreviewInfo,
  RedoEvent,
  UIAdapter,
  UndoEvent,
} from '../types';

/** Minimal UI adapter for tests and headless usage: records everything. */
export class InMemoryUI implements UIAdapter {
  readonly changeSets = new Map<string, { changeset: ChangeSet; preview: PreviewInfo | null }>();
  readonly receipts: ChangeSetReceipt[] = [];
  readonly undos: UndoEvent[] = [];
  readonly redos: RedoEvent[] = [];
  readonly audit: AuditEntry[] = [];

  onChangesetUpdated(cs: ChangeSet, preview: PreviewInfo | null): void {
    this.changeSets.set(cs.id, { changeset: structuredClone(cs), preview });
  }

  onReceipt(receipt: ChangeSetReceipt): void {
    this.receipts.push(structuredClone(receipt));
  }

  onUndo(event: UndoEvent): void {
    this.undos.push({ ...event });
  }

  onRedo(event: RedoEvent): void {
    this.redos.push({ ...event });
  }

  onAudit(entry: AuditEntry): void {
    this.audit.push({ ...entry });
  }

  lastChangeSetId(): string {
    const keys = [...this.changeSets.keys()];
    if (keys.length === 0) throw new Error('no ChangeSets recorded');
    return keys[keys.length - 1];
  }
}
