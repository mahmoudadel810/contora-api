import { HttpException, Injectable } from '@nestjs/common';
import type { Principal } from '../auth/principal.js';
import { toErrorBody } from '../common/app-exception.filter.js';
import { RecordsService } from '../records/records.service.js';
import { TrashService } from '../trash/trash.service.js';

export interface BulkItemResult {
  id: string;
  ok: boolean;
  code?: string;
  message?: string;
}

export interface BulkResult {
  succeeded: number;
  failed: number;
  results: BulkItemResult[];
}

@Injectable()
export class BulkService {
  constructor(
    private readonly records: RecordsService,
    private readonly trash: TrashService,
  ) {}

  move(principal: Principal, ids: string[], folderId: string): Promise<BulkResult> {
    return this.each(ids, (id) => this.records.move(principal, id, { folderId }));
  }

  trashRecords(principal: Principal, ids: string[]): Promise<BulkResult> {
    return this.each(ids, (id) => this.trash.trashRecord(principal, id));
  }

  retag(principal: Principal, ids: string[], add: string[], remove: string[]): Promise<BulkResult> {
    return this.each(ids, (id) => this.records.changeTags(principal, id, { add, remove }));
  }

  private async each(ids: string[], action: (id: string) => Promise<unknown>): Promise<BulkResult> {
    const results: BulkItemResult[] = [];
    for (const id of ids) {
      try {
        await action(id);
        results.push({ id, ok: true });
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        const body = toErrorBody(error);
        results.push({ id, ok: false, code: body.code, message: body.message });
      }
    }
    const succeeded = results.filter((r) => r.ok).length;
    return { succeeded, failed: results.length - succeeded, results };
  }
}
