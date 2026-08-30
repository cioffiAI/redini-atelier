import type {
  AuditEntry,
  PreviewInfo,
  Receipt,
  Transaction,
  UIAdapter,
  UndoEvent,
} from '../types';

/** Minimal UI adapter for tests and headless usage: records everything. */
export class InMemoryUI implements UIAdapter {
  readonly transactions = new Map<string, { transaction: Transaction; preview: PreviewInfo | null }>();
  readonly receipts: Receipt[] = [];
  readonly undos: UndoEvent[] = [];
  readonly audit: AuditEntry[] = [];

  onTransactionUpdated(tx: Transaction, preview: PreviewInfo | null): void {
    this.transactions.set(tx.id, { transaction: structuredClone(tx), preview });
  }

  onReceipt(receipt: Receipt): void {
    this.receipts.push(structuredClone(receipt));
  }

  onUndo(event: UndoEvent): void {
    this.undos.push({ ...event });
  }

  onAudit(entry: AuditEntry): void {
    this.audit.push({ ...entry });
  }

  lastTransactionId(): string {
    const keys = [...this.transactions.keys()];
    if (keys.length === 0) throw new Error('no transactions recorded');
    return keys[keys.length - 1];
  }
}
