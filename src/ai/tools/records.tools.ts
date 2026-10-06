import { z } from 'zod';
import type { FieldDefinition } from '../../content-types/field-types.js';
import type { RecordDetailView } from '../../records/record.view.js';
import { isPreviewable, recordCardOf, type BlockDraft } from '../blocks.js';
import { recordLink } from '../links.js';
import { MODEL_ROWS, objectId } from './search.tools.js';
import { defineTool, type ToolDef } from './tool.js';

export function valueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(valueText).join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value as string | number);
}

function labelled(detail: RecordDetailView): Array<{ key: string; label: string; value: string }> {
  const fields: FieldDefinition[] = detail.contentType.fields;
  const known = new Set(fields.map((field) => field.key));
  const rows = fields
    .filter((field) => detail.record.metadata[field.key] !== undefined)
    .map((field) => ({
      key: field.key,
      label: field.label,
      value: valueText(detail.record.metadata[field.key]),
    }));
  for (const [key, value] of Object.entries(detail.record.metadata)) {
    if (!known.has(key)) rows.push({ key, label: key, value: valueText(value) });
  }
  return rows;
}

const recordsGetRecord = defineTool({
  name: 'records_get_record',
  domain: 'records',
  description:
    'One record: name, type, folder path, tags, metadata values, version count, check-out state and file.',
  input: z.object({ id: objectId }).strict(),
  async run(ctx, input) {
    const detail = await ctx.services.records.get(ctx.principal, input.id);
    const { record } = detail;
    const metadata = labelled(detail);
    const blocks: BlockDraft[] = [
      {
        kind: 'record',
        record: {
          ...recordCardOf(record),
          metadata: metadata.map(({ label, value }) => ({ label, value })),
          versions: record.currentVersion,
          checkedOutBy: record.checkedOut?.displayName ?? null,
        },
        scope: {
          domain: 'records',
          cardFolders: record.folderId ? { [record.id]: record.folderId } : {},
        },
      },
    ];
    if (record.file) {
      blocks.push({
        kind: 'file',
        recordId: record.id,
        fileName: record.file.fileName,
        mimeType: record.file.mimeType,
        size: record.file.size,
        previewable: isPreviewable(record.file.mimeType),
        link: recordLink(record.id),
      });
    }
    return {
      data: {
        id: record.id,
        name: record.name,
        contentType: { id: record.contentTypeId, name: record.contentTypeName },
        folder: { id: record.folderId, name: record.folderName },
        path: detail.breadcrumbs.map((crumb) => crumb.name).join(' / '),
        tags: record.tags,
        currentVersion: record.currentVersion,
        checkedOutBy: record.checkedOut?.displayName ?? null,
        metadata: Object.fromEntries(metadata.map(({ key, value }) => [key, value])),
        file: record.file
          ? { name: record.file.fileName, mimeType: record.file.mimeType, size: record.file.size }
          : null,
        updatedAt: record.updatedAt,
        updatedBy: record.updatedBy.displayName,
      },
      blocks,
    };
  },
});

const recordsListVersions = defineTool({
  name: 'records_list_versions',
  domain: 'records',
  description: 'The version history of one record, newest first.',
  input: z.object({ id: objectId }).strict(),
  async run(ctx, input) {
    const versions = await ctx.services.records.listVersions(ctx.principal, input.id);
    const rows = versions.map((version) => ({
      versionNumber: version.versionNumber,
      createdAt: version.createdAt,
      createdBy: version.createdBy.displayName,
      comment: version.comment,
      fileName: version.file?.fileName ?? null,
      restoredFrom: version.restoredFrom,
      isCurrent: version.isCurrent,
    }));
    return {
      data: {
        total: rows.length,
        truncated: rows.length > MODEL_ROWS,
        items: rows.slice(0, MODEL_ROWS),
      },
      blocks: [
        {
          kind: 'table',
          title: 'Versions',
          columns: ['Version', 'Date', 'By', 'Comment', 'File'],
          rows: rows
            .slice(0, MODEL_ROWS)
            .map((row) => [
              String(row.versionNumber),
              row.createdAt,
              row.createdBy,
              row.comment,
              row.fileName ?? '',
            ]),
          truncated: rows.length > MODEL_ROWS,
          scope: { domain: 'records', recordId: input.id },
        },
      ],
    };
  },
});

export const RECORDS_TOOLS: ToolDef[] = [recordsGetRecord, recordsListVersions] as ToolDef[];
