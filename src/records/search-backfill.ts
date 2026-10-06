import { setTimeout as sleep } from 'node:timers/promises';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, QueryFilter, Types } from 'mongoose';
import { SEARCH_KEY_VERSION } from '../common/arabic-normalize.js';
import { isObjectId, toObjectId } from '../database/object-id.js';
import { Tenant } from '../tenants/tenant.schema.js';
import type { RecordEntity } from './record.schema.js';
import { RecordsRepository, type BackfillRow } from './records.repository.js';
import { isStale, metaKeysOf, staleKeysFilter, staleMarker, textKeyUpdate } from './search-keys.js';

export interface BackfillOptions {
  dryRun?: boolean;
  tenantId?: string;
  all?: boolean;
  batchSize?: number;
  pauseMs?: number;
  log?: (line: string) => void;
}

export interface BackfillCounts {
  scanned: number;
  updated: number;
  skipped: number;
  failed: number;
  remaining: number;
}

export interface BackfillSummary extends BackfillCounts {
  tenants: number;
  elapsedMs: number;
}

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_PAUSE_MS = 50;

type Outcome = 'updated' | 'skipped' | 'failed';

function emptyCounts(): BackfillCounts {
  return { scanned: 0, updated: 0, skipped: 0, failed: 0, remaining: 0 };
}

function countsLine(counts: BackfillCounts): string {
  return (
    `scanned ${counts.scanned}, updated ${counts.updated}, skipped ${counts.skipped}, ` +
    `failed ${counts.failed}, remaining ${counts.remaining}`
  );
}

function describeError(error: unknown): string {
  if (typeof error !== 'object' || error === null) return typeof error;
  const { name, code } = error as { name?: unknown; code?: unknown };
  const parts = [typeof name === 'string' ? name : 'Error'];
  if (typeof code === 'string' || typeof code === 'number') parts.push(`code ${code}`);
  return parts.join(' ');
}

function markerOf(search: unknown, marker: 'v' | 'mv'): unknown {
  return typeof search === 'object' && search !== null
    ? (search as Record<string, unknown>)[marker]
    : undefined;
}

function metadataOf(row: BackfillRow): Record<string, unknown> {
  const { metadata } = row;
  return typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

export function parseBackfillArgs(
  args: string[],
): Pick<BackfillOptions, 'dryRun' | 'tenantId' | 'all'> {
  const options: Pick<BackfillOptions, 'dryRun' | 'tenantId' | 'all'> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--tenant') {
      const id = args[index + 1];
      if (id === undefined || !isObjectId(id)) throw new Error('--tenant needs a tenant id');
      options.tenantId = id;
      index += 1;
    } else throw new Error(`Unknown argument ${JSON.stringify(arg)}`);
  }
  return options;
}

@Injectable()
export class SearchBackfill {
  private readonly logger = new Logger('SearchBackfill');

  constructor(
    private readonly records: RecordsRepository,
    @InjectModel(Tenant.name) private readonly tenants: Model<Tenant>,
  ) {}

  async run(options: BackfillOptions = {}): Promise<BackfillSummary> {
    const started = Date.now();
    const log = options.log ?? ((line: string) => this.logger.log(line));
    const tenantIds = await this.tenantIds(options.tenantId);
    const total = emptyCounts();
    for (const tenantId of tenantIds) {
      const counts = await this.runTenant(tenantId, options, log);
      total.scanned += counts.scanned;
      total.updated += counts.updated;
      total.skipped += counts.skipped;
      total.failed += counts.failed;
      total.remaining += counts.remaining;
    }
    const elapsedMs = Date.now() - started;
    log(
      `${options.dryRun ? 'dry run ' : ''}total over ${tenantIds.length} tenants: ` +
        `${countsLine(total)} in ${elapsedMs} ms`,
    );
    return { ...total, tenants: tenantIds.length, elapsedMs };
  }

  private async tenantIds(only: string | undefined): Promise<string[]> {
    if (only !== undefined) {
      if (!isObjectId(only)) throw new Error('Not a tenant id');
      const exists = await this.tenants.exists({ _id: toObjectId(only) }).exec();
      if (!exists) throw new Error(`No tenant ${only}`);
      return [only];
    }
    const tenants = await this.tenants.find({}, { _id: 1 }).sort({ _id: 1 }).lean().exec();
    return tenants.map((tenant) => tenant._id.toHexString());
  }

  private async runTenant(
    tenantId: string,
    options: BackfillOptions,
    log: (line: string) => void,
  ): Promise<BackfillCounts> {
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const pauseMs = options.pauseMs ?? DEFAULT_PAUSE_MS;
    const all = options.all === true;
    const counts = emptyCounts();
    let afterId: Types.ObjectId | null = null;
    for (let batch = 1; ; batch += 1) {
      const rows = await this.records.backfillPage(tenantId, afterId, batchSize, { all });
      if (rows.length === 0) break;
      const batchCounts = emptyCounts();
      for (const row of rows) {
        batchCounts.scanned += 1;
        if (options.dryRun) continue;
        try {
          batchCounts[await this.backfillRecord(tenantId, row, all)] += 1;
        } catch (error) {
          batchCounts.failed += 1;
          log(
            `tenant ${tenantId}: record ${row._id.toHexString()} failed: ${describeError(error)}`,
          );
        }
      }
      counts.scanned += batchCounts.scanned;
      counts.updated += batchCounts.updated;
      counts.skipped += batchCounts.skipped;
      counts.failed += batchCounts.failed;
      log(
        `tenant ${tenantId} batch ${batch}: scanned ${batchCounts.scanned}, updated ${batchCounts.updated}, ` +
          `skipped ${batchCounts.skipped}, failed ${batchCounts.failed}`,
      );
      afterId = rows[rows.length - 1]._id;
      if (rows.length < batchSize) break;
      if (pauseMs > 0) await sleep(pauseMs);
    }
    counts.remaining = await this.records.count(tenantId, staleKeysFilter());
    log(`tenant ${tenantId}: ${countsLine(counts)}`);
    return counts;
  }

  private async backfillRecord(
    tenantId: string,
    row: BackfillRow,
    all: boolean,
  ): Promise<Exclude<Outcome, 'failed'>> {
    let missed = false;
    if (all || isStale(markerOf(row.search, 'v'))) {
      const guard = {
        _id: row._id,
        searchText: row.searchText ?? null,
        ...(all ? {} : { 'search.v': staleMarker() }),
      } as QueryFilter<RecordEntity>;
      const searchText = typeof row.searchText === 'string' ? row.searchText : '';
      if (!(await this.records.updateDerived(tenantId, guard, textKeyUpdate(searchText)))) {
        missed = true;
      }
    }
    if (all || isStale(markerOf(row.search, 'mv'))) {
      const guard = {
        _id: row._id,
        currentVersion: row.currentVersion ?? null,
        ...(all ? {} : { 'search.mv': staleMarker() }),
      } as QueryFilter<RecordEntity>;
      const set = {
        'search.meta': metaKeysOf(metadataOf(row)),
        'search.mv': SEARCH_KEY_VERSION,
      };
      if (!(await this.records.updateDerived(tenantId, guard, set))) missed = true;
    }
    return missed ? 'skipped' : 'updated';
  }
}
