import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { Principal } from '../auth/principal.js';
import { PolicyService } from '../authorization/policy.service.js';
import { errors } from '../common/errors.js';
import type { AuditAction } from './audit-action.js';
import { AuditEntriesRepository } from './audit-entries.repository.js';

const DAY_MS = 86_400_000;
const MAX_DAYS = 366;
const DEFAULT_DAYS = 30;
const TOP_USERS = 10;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const ActivityReportQuerySchema = z
  .object({ from: day.optional(), to: day.optional() })
  .strict();
export type ActivityReportQuery = z.infer<typeof ActivityReportQuerySchema>;

export interface ActivityReport {
  from: string;
  to: string;
  total: number;
  denied: number;
  perDay: { day: string; count: number }[];
  byAction: { action: AuditAction; count: number }[];
  topUsers: { id: string; displayName: string; count: number }[];
}

interface Facets {
  perDay: { _id: string; count: number }[];
  byAction: { _id: AuditAction; count: number }[];
  topUsers: { _id: { toHexString(): string }; displayName: string; count: number }[];
  total: { n: number }[];
  denied: { n: number }[];
}

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

function parseDay(value: string, field: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || isoDay(date) !== value) {
    throw errors.validation([{ path: field, message: 'Invalid date' }]);
  }
  return date;
}

@Injectable()
export class ActivityReportService {
  constructor(
    private readonly entries: AuditEntriesRepository,
    private readonly policy: PolicyService,
  ) {}

  async report(principal: Principal, query: ActivityReportQuery): Promise<ActivityReport> {
    await this.policy.authorize(principal, 'audit.readAll', { type: 'report', label: 'activity' });
    const today = parseDay(isoDay(new Date()), 'to');
    const to = query.to ? parseDay(query.to, 'to') : today;
    const from = query.from
      ? parseDay(query.from, 'from')
      : new Date(to.getTime() - (DEFAULT_DAYS - 1) * DAY_MS);
    const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
    if (days < 1) throw errors.badRequest('INVALID_RANGE', '"from" must not be after "to"');
    if (days > MAX_DAYS) {
      throw errors.badRequest('RANGE_TOO_LONG', `Choose at most ${MAX_DAYS} days`);
    }

    const [facets] = await this.entries.aggregate<Facets>(
      principal.tenantId,
      { createdAt: { $gte: from, $lt: new Date(to.getTime() + DAY_MS) } },
      [
        {
          $facet: {
            perDay: [
              {
                $group: {
                  _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                  count: { $sum: 1 },
                },
              },
            ],
            byAction: [
              { $group: { _id: '$action', count: { $sum: 1 } } },
              { $sort: { count: -1, _id: 1 } },
            ],
            topUsers: [
              { $match: { actor: { $ne: null } } },
              { $sort: { createdAt: 1 } },
              {
                $group: {
                  _id: '$actor.id',
                  displayName: { $last: '$actor.displayName' },
                  count: { $sum: 1 },
                },
              },
              { $sort: { count: -1, displayName: 1 } },
              { $limit: TOP_USERS },
            ],
            total: [{ $count: 'n' }],
            denied: [{ $match: { action: 'ACCESS_DENIED' } }, { $count: 'n' }],
          },
        },
      ],
    );

    const counts = new Map(facets.perDay.map((row) => [row._id, row.count]));
    const perDay = Array.from({ length: days }, (_, i) => {
      const key = isoDay(new Date(from.getTime() + i * DAY_MS));
      return { day: key, count: counts.get(key) ?? 0 };
    });
    return {
      from: isoDay(from),
      to: isoDay(to),
      total: facets.total[0]?.n ?? 0,
      denied: facets.denied[0]?.n ?? 0,
      perDay,
      byAction: facets.byAction.map((row) => ({ action: row._id, count: row.count })),
      topUsers: facets.topUsers.map((row) => ({
        id: row._id.toHexString(),
        displayName: row.displayName,
        count: row.count,
      })),
    };
  }
}
