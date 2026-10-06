import type { Action } from '../authorization/policy.js';
import { ConfirmBodySchema } from '../ai/ai.dto.js';
import { StartExtractionSchema } from '../ai-extraction/ai-extraction.dto.js';
import { CreateRecordSchema, NewVersionSchema } from '../records/records.dto.js';
import type { z } from 'zod';

export type DocumentedStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 503;

export const ROUTE_SCOPES = ['none', 'personal', 'admin', 'record', 'folder', 'records'] as const;
export type RouteScope = (typeof ROUTE_SCOPES)[number];

export interface RouteDoc {
  summary: string;
  description?: string;
  access: Action | 'public' | 'signed-in';
  scope: RouteScope;
  level?: 'view' | 'edit';
  response: string;
  produces?:
    | 'application/json'
    | 'text/csv'
    | 'application/octet-stream'
    | 'text/html'
    | 'text/event-stream'
    | 'application/x-ndjson';
  errors?: Partial<Record<DocumentedStatus, readonly string[]>>;
  multipart?: z.ZodType;
}

export const ROUTE_DOCS: Record<string, RouteDoc> = {
  'POST /auth/sign-up': {
    summary: 'Create a tenant and its first admin, and sign in',
    access: 'public',
    scope: 'none',
    response: 'The session: access token, user and tenant; sets the refresh cookie',
    errors: { 409: ['EMAIL_TAKEN'] },
  },
  'POST /auth/sign-in': {
    summary: 'Sign in with email and password',
    access: 'public',
    scope: 'none',
    response: 'The session; sets the refresh cookie',
    errors: { 401: ['UNAUTHENTICATED'] },
  },
  'POST /auth/refresh': {
    summary: 'Exchange the refresh cookie for a new access token',
    description: 'Rotates the refresh token. Presenting a rotated token again revokes the session.',
    access: 'public',
    scope: 'none',
    response: 'The session; sets the next refresh cookie',
    errors: { 401: ['UNAUTHENTICATED'] },
  },
  'POST /auth/sign-out': {
    summary: 'End the session of the refresh cookie',
    access: 'public',
    scope: 'none',
    response: 'No content; clears the refresh cookie',
  },
  'GET /auth/me': {
    summary: 'The signed-in user and their tenant',
    access: 'signed-in',
    scope: 'personal',
    response: '`{ user, tenant }`',
  },
  'PATCH /auth/me': {
    summary: 'Change your display name',
    access: 'signed-in',
    scope: 'personal',
    response: 'The updated user',
  },
  'POST /auth/change-password': {
    summary: 'Change your password',
    description:
      'Ends every session and access token of the user and starts a new session. Rate limited per client address and per user.',
    access: 'signed-in',
    scope: 'personal',
    response: 'The new session; sets the refresh cookie',
    errors: { 400: ['WRONG_PASSWORD'] },
  },
  'GET /auth/sessions': {
    summary: 'Your sessions',
    access: 'signed-in',
    scope: 'personal',
    response: '`{ items, accessTokenTtlSeconds }`; the refresh cookie’s session is marked current',
  },
  'DELETE /auth/sessions/{sid}': {
    summary: 'End one of your other sessions',
    access: 'signed-in',
    scope: 'personal',
    response: 'No content',
    errors: { 400: ['CURRENT_SESSION'] },
  },
  'DELETE /auth/sessions': {
    summary: 'End all your sessions but the current one',
    access: 'signed-in',
    scope: 'personal',
    response: '`{ revoked }`',
  },
  'GET /members/{id}/sessions': {
    summary: 'A member’s sessions',
    access: 'sessions.manage',
    scope: 'admin',
    response: '`{ items, accessTokenTtlSeconds }`',
  },
  'DELETE /members/{id}/sessions/{sid}': {
    summary: 'End one session of a member',
    access: 'sessions.manage',
    scope: 'admin',
    response: 'No content',
  },
  'DELETE /members/{id}/sessions': {
    summary: 'End every session of a member and cut off their access tokens',
    access: 'sessions.manage',
    scope: 'admin',
    response: '`{ revoked }`',
  },

  'GET /members': {
    summary: 'The tenant’s members',
    access: 'members.read',
    scope: 'admin',
    response: 'Users; last sign-in times for admins only',
  },
  'PATCH /members/{id}': {
    summary: 'Change a member’s role',
    access: 'members.manage',
    scope: 'admin',
    response: 'The updated member',
    errors: { 409: ['LAST_ADMIN', 'MEMBER_SUSPENDED', 'MEMBER_CHANGED_CONCURRENTLY'] },
  },
  'POST /members/{id}/suspend': {
    summary: 'Suspend a member',
    access: 'members.manage',
    scope: 'admin',
    response: 'The member',
    errors: { 400: ['CANNOT_SUSPEND_SELF'], 409: ['LAST_ADMIN', 'MEMBER_CHANGED_CONCURRENTLY'] },
  },
  'POST /members/{id}/reactivate': {
    summary: 'Reactivate a suspended member',
    access: 'members.manage',
    scope: 'admin',
    response: 'The member',
  },
  'DELETE /members/{id}': {
    summary: 'Remove a member',
    access: 'members.manage',
    scope: 'admin',
    response: 'No content',
    errors: { 400: ['CANNOT_REMOVE_SELF'], 409: ['LAST_ADMIN', 'MEMBER_CHANGED_CONCURRENTLY'] },
  },
  'GET /people': {
    summary: 'Active users of the tenant, names only',
    description:
      'For user fields and names shown next to content; no email, role or status. Sorted by ' +
      'name, at most 1000.',
    access: 'signed-in',
    scope: 'none',
    response: '`[{ id, displayName }]`',
  },

  'GET /access/grants': {
    summary: 'Access grants of one member, or on one folder or record',
    description:
      'Give either `userId` (that member’s grants, with target names) or `targetType` and ' +
      '`targetId` (the grants on that live target, and those inherited from the folders above it, ' +
      'root first, each with `from`).',
    access: 'access.manage',
    scope: 'admin',
    response:
      'With `userId`: grants. With a target: `{ target: { type, id, name }, direct, inherited }`',
    errors: { 404: ['NOT_FOUND'] },
  },
  'PUT /access/grants': {
    summary: 'Give a member View or Edit on a folder (and everything beneath it) or a record',
    description:
      'Creates the grant or changes its level; one grant per member and target. The root is a ' +
      'folder grant on the root folder. The same level again changes and records nothing. ' +
      'Refused for an admin, a suspended member, a removed member and a trashed target.',
    access: 'access.manage',
    scope: 'admin',
    response: 'The grant plus `created`',
    errors: {
      404: ['NOT_FOUND'],
      409: ['GRANTEE_IS_ADMIN', 'GRANTEE_SUSPENDED', 'GRANT_LIMIT', 'GRANT_CHANGED_CONCURRENTLY'],
    },
  },
  'DELETE /access/grants/{id}': {
    summary: 'Revoke an access grant',
    description:
      'Succeeds while the member holds a check-out; `heldCheckouts` lists the records they still ' +
      'have checked out but can no longer edit (an admin can force-release them).',
    access: 'access.manage',
    scope: 'admin',
    response: '`{ heldCheckouts: { id, name }[] }`',
    errors: { 404: ['NOT_FOUND'] },
  },
  'POST /records/{id}/share-links': {
    summary: 'Create a share link to the record’s current file',
    description:
      'Needs Edit on the record (admins always have it). `expiresAt` is mandatory: in the future ' +
      'and at most 90 days away. An optional `password` is 8–128 characters and at most 72 bytes. ' +
      'At most 20 active links per record. The `url` (with the token in its fragment) is in this ' +
      'response only; it cannot be shown again. Rate limited per client address and per user.',
    access: 'shareLinks.create',
    scope: 'record',
    response: 'The link plus its `url`',
    errors: {
      400: ['SHARE_LINK_EXPIRY_INVALID'],
      403: ['FORBIDDEN'],
      404: ['NOT_FOUND'],
      409: ['RECORD_HAS_NO_FILE', 'TOO_MANY_SHARE_LINKS'],
    },
  },
  'GET /records/{id}/share-links': {
    summary: 'The record’s share links, newest first, in every status',
    description: 'Needs Edit on the record, like creating one. Never shows a link’s url or token.',
    access: 'shareLinks.create',
    scope: 'record',
    response: '`{ items, total, page, pageSize }`',
    errors: { 403: ['FORBIDDEN'], 404: ['NOT_FOUND'] },
  },
  'DELETE /share-links/{id}': {
    summary: 'Revoke a share link',
    description:
      'Its sharer can always revoke it; an admin can revoke any. Anyone else gets 403 when they ' +
      'can View the record, else 404.',
    access: 'shareLinks.revokeOwn',
    scope: 'record',
    response: 'No content',
    errors: { 403: ['FORBIDDEN'], 404: ['NOT_FOUND'], 409: ['SHARE_LINK_NOT_ACTIVE'] },
  },
  'GET /share-links': {
    summary: 'The tenant’s share links (active by default; `status=all` for every one)',
    access: 'shareLinks.manageAll',
    scope: 'admin',
    response:
      '`{ items, total, page, pageSize }`; each link with `record: { id, name, trashed } | null`',
  },
  'GET /public/share-link': {
    summary: 'What a share link points to (anonymous)',
    description:
      'Send the token as the `X-Share-Token` header (and a password link’s unlock proof as ' +
      '`X-Share-Access`). A password link without a valid proof answers `{ passwordRequired: true }`. ' +
      'Every dead, unknown or malformed link answers the same 404. Responses are `no-store`.',
    access: 'public',
    scope: 'none',
    response:
      '`{ passwordRequired: true }` or `{ passwordRequired: false, fileName, size, mimeType, ' +
      'sharedByName, expiresAt, inlinePreview }`',
    errors: { 404: ['NOT_FOUND'] },
  },
  'POST /public/share-link/unlock': {
    summary: 'Unlock a password share link (anonymous)',
    description:
      'Send the token as `X-Share-Token`. The returned `access` is sent as `X-Share-Access` until ' +
      '`accessExpiresAt` (at most 30 minutes). Ten wrong passwords in 15 minutes lock the link ' +
      'for 15 minutes.',
    access: 'public',
    scope: 'none',
    response: '`{ access, accessExpiresAt, file }` (`file` as from GET /public/share-link)',
    errors: {
      403: ['SHARE_LINK_PASSWORD_INCORRECT'],
      404: ['NOT_FOUND'],
      429: ['SHARE_LINK_LOCKED'],
    },
  },
  'GET /public/share-link/content': {
    summary: 'Download or preview a share link’s file (anonymous)',
    description:
      'Send `X-Share-Token` (and `X-Share-Access` for a password link). Only images, PDF and ' +
      'plain text are ever served inline; everything else is an attachment.',
    access: 'public',
    scope: 'none',
    response: 'The current file’s bytes',
    produces: 'application/octet-stream',
    errors: { 403: ['SHARE_LINK_PASSWORD_REQUIRED'], 404: ['NOT_FOUND'] },
  },
  'POST /invitations': {
    summary: 'Invite someone by email',
    access: 'invitations.manage',
    scope: 'admin',
    response: 'The invitation with its accept link',
    errors: { 409: ['EMAIL_TAKEN', 'MEMBER_SUSPENDED'] },
  },
  'GET /invitations': {
    summary: 'The tenant’s invitations',
    access: 'invitations.manage',
    scope: 'admin',
    response: 'Invitations with their status',
  },
  'GET /invitations/preview': {
    summary: 'What an invitation token is for',
    access: 'public',
    scope: 'none',
    response: 'Tenant name, email, role and status of the invitation',
    errors: { 409: ['INVITATION_NOT_PENDING'] },
  },
  'POST /invitations/accept': {
    summary: 'Accept an invitation and sign in',
    access: 'public',
    scope: 'none',
    response: 'The session; sets the refresh cookie',
    errors: { 409: ['INVITATION_NOT_PENDING', 'EMAIL_TAKEN'] },
  },
  'DELETE /invitations/{id}': {
    summary: 'Revoke an invitation',
    access: 'invitations.manage',
    scope: 'admin',
    response: 'No content',
    errors: { 409: ['INVITATION_NOT_PENDING'] },
  },

  'GET /content-types': {
    summary: 'Content types',
    access: 'contentTypes.read',
    scope: 'none',
    response: 'Content types with their fields',
  },
  'GET /content-types/{id}': {
    summary: 'One content type',
    access: 'contentTypes.read',
    scope: 'none',
    response: 'The content type',
  },
  'POST /content-types': {
    summary: 'Create a content type',
    access: 'contentTypes.manage',
    scope: 'admin',
    response: 'The content type',
    errors: { 409: ['NAME_TAKEN'] },
  },
  'PATCH /content-types/{id}': {
    summary: 'Change a content type (a field change bumps its schema version)',
    access: 'contentTypes.manage',
    scope: 'admin',
    response: 'The content type',
    errors: { 409: ['NAME_TAKEN'] },
  },
  'POST /content-types/{id}/archive': {
    summary: 'Archive a content type (no new records)',
    access: 'contentTypes.manage',
    scope: 'admin',
    response: 'The content type',
  },
  'POST /content-types/{id}/unarchive': {
    summary: 'Unarchive a content type',
    access: 'contentTypes.manage',
    scope: 'admin',
    response: 'The content type',
  },
  'DELETE /content-types/{id}': {
    summary: 'Delete an unused content type',
    access: 'contentTypes.manage',
    scope: 'admin',
    response: 'No content',
    errors: { 409: ['CONTENT_TYPE_IN_USE', 'CONTENT_TYPE_DELETING'] },
  },

  'GET /folders/root': {
    summary: 'The root folder with its children',
    access: 'folders.read',
    scope: 'folder',
    response: 'Folder detail: folder, subfolders, breadcrumbs',
  },
  'GET /folders/tree': {
    summary: 'All live folders',
    access: 'folders.read',
    scope: 'folder',
    response: 'Folders',
  },
  'GET /folders/{id}': {
    summary: 'A folder with its children',
    access: 'folders.read',
    scope: 'folder',
    response: 'Folder detail: folder, subfolders, breadcrumbs',
  },
  'POST /folders': {
    summary: 'Create a folder',
    access: 'folders.write',
    scope: 'folder',
    response: 'The folder',
    errors: { 409: ['NAME_TAKEN'] },
  },
  'PATCH /folders/{id}': {
    summary: 'Rename a folder',
    access: 'folders.write',
    scope: 'folder',
    response: 'The folder',
    errors: { 400: ['ROOT_FOLDER'], 409: ['NAME_TAKEN'] },
  },
  'POST /folders/{id}/move': {
    summary: 'Move a folder under another folder',
    access: 'folders.write',
    scope: 'folder',
    response: 'The folder',
    errors: {
      400: ['ROOT_FOLDER', 'INVALID_MOVE'],
      409: ['NAME_TAKEN', 'FOLDER_MOVE_IN_PROGRESS', 'FOLDER_MOVED_CONCURRENTLY'],
    },
  },
  'DELETE /folders/{id}': {
    summary: 'Move a folder, its subfolders and records to the trash',
    access: 'folders.trash',
    scope: 'folder',
    response: 'No content',
    errors: { 400: ['ROOT_FOLDER'], 409: ['RECORD_CHECKED_OUT'] },
  },

  'GET /records': {
    summary: 'Search records',
    description:
      'Filters by text, content type, folder (optionally with subfolders), tags, dates and metadata (`meta.<field>=value`). ' +
      'Text search ignores Arabic letter variants (أ/إ/آ/ا, ى/ي, ة/ه, ؤ/و, ئ/ي), diacritics, tatweel, and Arabic-Indic/Persian digits. ' +
      'Text searches (`q` or `meta.*`) are rate limited per user and time out with 503 `SEARCH_TIMEOUT`.',
    access: 'records.read',
    scope: 'records',
    response: 'A page of records: `{ items, total, page, pageSize }`',
    errors: { 400: ['INVALID_FILTER'], 503: ['SEARCH_TIMEOUT'] },
  },
  'GET /records/export': {
    summary: 'Export a search as CSV',
    description:
      'The filters of `GET /records`, with the same Arabic-aware text search, rate limit and time limit.',
    access: 'records.read',
    scope: 'records',
    response: 'CSV (at most 5000 rows); `X-Export-Count` and `X-Export-Truncated` headers',
    produces: 'text/csv',
    errors: { 400: ['INVALID_FILTER'], 503: ['SEARCH_TIMEOUT'] },
  },
  'POST /records': {
    summary: 'Create a record (version 1), optionally with a file',
    description: 'JSON, or multipart with the fields below and a `file` part.',
    access: 'records.write',
    scope: 'folder',
    response: 'The record',
    multipart: CreateRecordSchema,
    errors: {
      404: ['NOT_FOUND'],
      409: ['CONTENT_TYPE_ARCHIVED', 'CONTENT_TYPE_DELETING'],
      413: ['PAYLOAD_TOO_LARGE'],
    },
  },
  'GET /records/{id}': {
    summary: 'A record with its content type and breadcrumbs',
    access: 'records.read',
    scope: 'record',
    response: '`{ record, contentType, breadcrumbs }`',
  },
  'PATCH /records/{id}': {
    summary: 'Rename a record',
    access: 'records.write',
    scope: 'record',
    response: 'The record',
    errors: { 409: ['RECORD_CHECKED_OUT', 'WRITE_CONFLICT'] },
  },
  'PUT /records/{id}/tags': {
    summary: 'Replace a record’s tags',
    access: 'records.write',
    scope: 'record',
    response: 'The record',
    errors: { 409: ['RECORD_CHECKED_OUT', 'WRITE_CONFLICT'] },
  },
  'POST /records/{id}/move': {
    summary: 'Move a record to another folder',
    access: 'records.write',
    scope: 'record',
    response: 'The record',
  },
  'GET /records/{id}/content': {
    summary: 'Download the current file',
    access: 'records.read',
    scope: 'record',
    response: 'The file (`?disposition=inline` only for safe types; always sandboxed)',
    produces: 'application/octet-stream',
  },
  'GET /records/{id}/versions': {
    summary: 'A record’s version history',
    access: 'records.read',
    scope: 'record',
    response: 'Versions, newest first',
  },
  'POST /records/{id}/versions': {
    summary: 'Add a version: a new file, new metadata or both',
    description: 'JSON, or multipart with the fields below and a `file` part.',
    access: 'records.write',
    scope: 'record',
    response: 'The new version',
    multipart: NewVersionSchema,
    errors: {
      400: ['NOTHING_TO_VERSION'],
      409: ['RECORD_CHECKED_OUT', 'VERSION_CONFLICT', 'WRITE_CONFLICT'],
      413: ['PAYLOAD_TOO_LARGE'],
    },
  },
  'GET /records/{id}/versions/{number}': {
    summary: 'One version',
    access: 'records.read',
    scope: 'record',
    response: 'The version',
  },
  'GET /records/{id}/versions/{number}/content': {
    summary: 'Download a version’s file',
    access: 'records.read',
    scope: 'record',
    response: 'The file',
    produces: 'application/octet-stream',
  },
  'POST /records/{id}/versions/{number}/restore': {
    summary: 'Restore a version as a new version',
    access: 'records.write',
    scope: 'record',
    response: 'The new version',
    errors: { 409: ['RECORD_CHECKED_OUT', 'VERSION_CONFLICT', 'WRITE_CONFLICT'] },
  },
  'POST /records/{id}/checkout': {
    summary: 'Check a record out (lock it for your edits)',
    access: 'records.checkout',
    scope: 'record',
    response: 'The record',
    errors: { 409: ['RECORD_CHECKED_OUT'] },
  },
  'POST /records/{id}/checkin': {
    summary: 'Check your record in',
    access: 'records.checkout',
    scope: 'record',
    response: 'The record',
    errors: { 409: ['NOT_CHECKED_OUT', 'RECORD_CHECKED_OUT'] },
  },
  'POST /records/{id}/force-release': {
    summary: 'Release someone else’s check-out',
    access: 'records.forceRelease',
    scope: 'admin',
    response: 'The record',
    errors: { 409: ['NOT_CHECKED_OUT', 'RECORD_CHECKED_OUT'] },
  },
  'DELETE /records/{id}': {
    summary: 'Move a record to the trash',
    access: 'records.trash',
    scope: 'record',
    response: 'No content',
    errors: { 409: ['RECORD_CHECKED_OUT'] },
  },
  'GET /records/{id}/activity': {
    summary: 'A record’s activity (its audit entries)',
    access: 'records.read',
    scope: 'record',
    response: 'A page of activity entries',
  },
  'GET /tags': {
    summary: 'Tags in use with their record counts',
    access: 'records.read',
    scope: 'records',
    response: '`[{ tag, count }]`',
  },

  'GET /records/{id}/comments': {
    summary: 'A record’s comments',
    access: 'records.read',
    scope: 'record',
    response: 'Comments, oldest first',
  },
  'POST /records/{id}/comments': {
    summary: 'Comment on a record',
    description:
      'The body (up to 4000 characters) may mention people as `@{user:<id>}`; each mentioned person gets a MENTION notification. One unavailable mention refuses the whole comment. Rate limited per user (30 a minute).',
    access: 'records.read',
    scope: 'record',
    level: 'view',
    response: 'The comment, with its raw body and the mentioned people’s current names',
    errors: { 400: ['MENTION_LIMIT_EXCEEDED', 'MENTION_SELF', 'MENTION_NO_ACCESS'] },
  },
  'DELETE /records/{id}/comments/{commentId}': {
    summary: 'Delete a comment (your own, or any as an admin)',
    access: 'records.read',
    scope: 'record',
    response: 'No content',
    errors: { 403: ['FORBIDDEN'] },
  },
  'GET /records/{id}/mentionable-users': {
    summary: 'People you can mention on a record',
    description:
      '`q` (up to 64 characters) matches the start of any word of the display name, and an email prefix only for callers who may read the member directory. Collaborators (creator, version authors, commenters) come first. Never returns emails. Rate limited per user (120 a minute).',
    access: 'records.read',
    scope: 'record',
    response: '`{ items: [{ id, displayName, collaborator }] }`, at most 20',
  },
  'GET /records/{id}/relations': {
    summary: 'A record’s relations, both directions',
    access: 'records.read',
    scope: 'record',
    response: '`{ items, total }`',
  },
  'POST /records/{id}/relations': {
    summary: 'Relate a record to another',
    access: 'records.write',
    scope: 'record',
    response: 'The relation',
    errors: { 400: ['SELF_RELATION'], 409: ['RELATION_EXISTS', 'RELATION_LIMIT'] },
  },
  'DELETE /records/{id}/relations/{relationId}': {
    summary: 'Remove a relation',
    access: 'records.write',
    scope: 'record',
    response: 'No content',
  },
  'POST /bulk/records/move': {
    summary: 'Move several records',
    access: 'records.write',
    scope: 'records',
    response: '`{ succeeded, failed, results }` with an error code per failed record',
  },
  'POST /bulk/records/trash': {
    summary: 'Trash several records',
    access: 'records.trash',
    scope: 'records',
    response: '`{ succeeded, failed, results }` with an error code per failed record',
  },
  'POST /bulk/records/tags': {
    summary: 'Add and remove tags on several records',
    access: 'records.write',
    scope: 'records',
    response: '`{ succeeded, failed, results }` (per record, e.g. `TOO_MANY_TAGS`)',
  },

  'GET /trash': {
    summary: 'Trashed folders and records',
    access: 'trash.read',
    scope: 'records',
    response: '`{ folders, records }`',
  },
  'POST /trash/records/{id}/restore': {
    summary: 'Restore a record (into the root when its folder is gone)',
    access: 'records.trash',
    scope: 'record',
    response: 'The record',
  },
  'POST /trash/folders/{id}/restore': {
    summary: 'Restore a folder with everything trashed with it',
    access: 'folders.trash',
    scope: 'folder',
    response: 'No content',
    errors: { 409: ['PARENT_IN_TRASH', 'NAME_TAKEN'] },
  },
  'DELETE /trash/records/{id}': {
    summary: 'Purge a trashed record for good',
    access: 'trash.purge',
    scope: 'admin',
    response: '`{ records, versions, blobsReleased }`',
  },
  'DELETE /trash/folders/{id}': {
    summary: 'Purge a trashed folder for good',
    access: 'trash.purge',
    scope: 'admin',
    response: '`{ records, versions, blobsReleased }`',
  },
  'DELETE /trash': {
    summary: 'Empty the trash',
    access: 'trash.purge',
    scope: 'admin',
    response: '`{ records, versions, blobsReleased }`',
  },

  'GET /records/{id}/favorite': {
    summary: 'Whether the record is one of your favorites',
    access: 'records.read',
    scope: 'record',
    response: '`{ favorite }`',
  },
  'PUT /records/{id}/favorite': {
    summary: 'Add a favorite',
    access: 'records.read',
    scope: 'record',
    level: 'view',
    response: 'No content',
  },
  'DELETE /records/{id}/favorite': {
    summary: 'Remove a favorite',
    access: 'records.read',
    scope: 'record',
    level: 'view',
    response: 'No content',
  },
  'POST /records/{id}/views': {
    summary: 'Note that you viewed a record (recently viewed)',
    access: 'records.read',
    scope: 'record',
    level: 'view',
    response: 'No content',
  },
  'GET /me/favorites': {
    summary: 'Your favorites',
    access: 'records.read',
    scope: 'records',
    response: 'Records',
  },
  'GET /me/recent': {
    summary: 'Records you viewed recently',
    access: 'records.read',
    scope: 'records',
    response: 'Records with the time you viewed them',
  },
  'GET /me/access': {
    summary: 'Where your access starts',
    description:
      'The folders and records granted to you with nothing visible above them (names only), ' +
      'where a member without a root grant starts browsing. Admins are unrestricted.',
    access: 'signed-in',
    scope: 'personal',
    response: '`{ unrestricted, entryPoints: [{ type, id, name, level }] }`',
  },
  'GET /saved-searches': {
    summary: 'Your saved searches',
    access: 'records.read',
    scope: 'personal',
    response: 'Saved searches',
  },
  'POST /saved-searches': {
    summary: 'Save a search',
    access: 'records.read',
    scope: 'personal',
    response: 'The saved search',
    errors: { 409: ['NAME_TAKEN', 'SAVED_SEARCH_LIMIT'] },
  },
  'DELETE /saved-searches/{id}': {
    summary: 'Delete a saved search',
    access: 'records.read',
    scope: 'personal',
    response: 'No content',
  },
  'GET /notifications': {
    summary: 'Your notifications',
    access: 'records.read',
    scope: 'personal',
    response: '`{ items, unread }`',
  },
  'GET /notifications/unread-count': {
    summary: 'How many notifications are unread',
    access: 'records.read',
    scope: 'personal',
    response: '`{ unread }`',
  },
  'POST /notifications/read-all': {
    summary: 'Mark all notifications read',
    access: 'records.read',
    scope: 'personal',
    response: 'No content',
  },
  'POST /notifications/{id}/read': {
    summary: 'Mark a notification read',
    access: 'records.read',
    scope: 'personal',
    response: 'No content',
  },
  'GET /notifications/stream': {
    summary: 'Your notifications, live (Server-Sent Events)',
    description:
      'Frames: `ready {unread}` on connect, `notification {item, unread}` for each new notification, `unread {unread}` after a read change, `cleared {commentId}` when a comment’s notifications lose their text, and a `: ping` comment every 25 s. The stream ends when the access token expires; reconnect with a fresh one. At most 5 open streams per user: a sixth sends `replaced {}` to the oldest and closes it (do not reconnect that one). Opening is rate limited per user (30 a minute).',
    access: 'records.read',
    scope: 'personal',
    response: 'An event stream that stays open',
    produces: 'text/event-stream',
  },

  'GET /audit': {
    summary: 'Audit entries (all for admins, your own for members)',
    access: 'audit.read',
    scope: 'admin',
    response: 'A page of entries plus `scope`',
  },
  'GET /audit/report': {
    summary: 'Activity report by day and action',
    access: 'audit.readAll',
    scope: 'admin',
    response: 'The report',
    errors: { 400: ['INVALID_RANGE', 'RANGE_TOO_LONG'] },
  },
  'GET /audit/actions': {
    summary: 'All audit action names',
    access: 'audit.read',
    scope: 'admin',
    response: 'Action names',
  },
  'GET /dashboard': {
    summary: 'Dashboard figures and recent activity',
    access: 'records.read',
    scope: 'records',
    response: 'The dashboard',
  },
  'GET /admin/overview': {
    summary: 'Tenant overview for admins',
    access: 'admin.overview',
    scope: 'admin',
    response: 'Members, sessions, storage and security figures',
  },

  'GET /health': {
    summary: 'Liveness',
    access: 'public',
    scope: 'none',
    response: '`{ status: "ok", time }`',
  },
  'GET /health/ready': {
    summary: 'Readiness: database and storage',
    access: 'public',
    scope: 'none',
    response: '`{ status, mongo, storage }`; the same body with 503 when not ready',
  },
  'GET /openapi.json': {
    summary: 'This API reference as an OpenAPI 3.1 document',
    access: 'public',
    scope: 'none',
    response: 'The OpenAPI document',
  },
  'GET /reference': {
    summary: 'This API reference as a readable page',
    access: 'public',
    scope: 'none',
    response: 'An HTML page (no scripts)',
    produces: 'text/html',
  },

  'GET /ai/status': {
    summary: 'Whether the assistant is configured, and what it offers you',
    description: 'Never 503: answers `enabled: false, reason: "NOT_CONFIGURED"` when AI is off.',
    access: 'signed-in',
    scope: 'personal',
    response: '`{ enabled, reason, model, maxMessageChars, actionTimeoutMs, domains }`',
  },
  'POST /ai/chat': {
    summary: 'Send a message to the assistant (or regenerate the last answer)',
    description:
      'Refusals come as normal JSON errors before the stream starts. The answer is a stream of newline-delimited JSON frames (`session`, `status`, `delta`, `tool`, `block`), ending with exactly one `finish` or `error` frame. Every 429 carries `details.retryAfterSeconds`.',
    access: 'signed-in',
    scope: 'personal',
    response: 'An NDJSON stream of frames',
    produces: 'application/x-ndjson',
    errors: {
      404: ['NOT_FOUND'],
      409: ['AI_TURN_IN_PROGRESS', 'AI_SESSION_FULL', 'AI_NOTHING_TO_REGENERATE'],
      429: ['AI_RATE_LIMITED', 'AI_TENANT_LIMIT', 'AI_USER_LIMIT'],
      503: ['AI_DISABLED'],
    },
  },
  'GET /ai/sessions': {
    summary: 'Your assistant chats, most recent first',
    access: 'signed-in',
    scope: 'personal',
    response:
      '`{ items: [{ id, title, messageCount, lastMessageAt, createdAt }], total, page, pageSize }`',
  },
  'GET /ai/sessions/{id}': {
    summary: 'One of your chats with its last 200 messages',
    description:
      'Stored cards are re-checked against what you can see now; items no longer available become a notice.',
    access: 'signed-in',
    scope: 'personal',
    response: '`{ session, messages, actions }`',
  },
  'PATCH /ai/sessions/{id}': {
    summary: 'Rename one of your chats',
    access: 'signed-in',
    scope: 'personal',
    response: 'The session',
  },
  'DELETE /ai/sessions/{id}': {
    summary: 'Delete one of your chats with its messages',
    access: 'signed-in',
    scope: 'personal',
    response: 'No content',
  },
  'POST /ai/actions/{id}/confirm': {
    summary: 'Run one of your pending assistant actions',
    description:
      'JSON `{}` or `{ acknowledgeDestructive: true }` (needed for a destructive action), or multipart with the field below and the `file` part the card asked for. Runs the same service call as the regular route, with your access now; the service error comes back unchanged and the action is marked failed. Works whether or not AI is configured.',
    access: 'signed-in',
    scope: 'personal',
    response:
      '`{ action }`: the action, now `done` (or `partial` for a bulk trash), with its `result`',
    multipart: ConfirmBodySchema,
    errors: {
      404: ['NOT_FOUND'],
      409: [
        'FILE_REQUIRED',
        'CONFIRMATION_REQUIRED',
        'ACTION_DEPENDENCY_PENDING',
        'ACTION_DEPENDENCY_FAILED',
        'ACTION_EXPIRED',
        'ACTION_NOT_PENDING',
        'ACTION_STALE',
        'ACTION_UNSUPPORTED',
      ],
      413: ['PAYLOAD_TOO_LARGE'],
    },
  },
  'POST /ai/actions/{id}/cancel': {
    summary: 'Cancel one of your pending assistant actions',
    access: 'signed-in',
    scope: 'personal',
    response: '`{ action }`, now `cancelled`',
    errors: { 404: ['NOT_FOUND'], 409: ['ACTION_NOT_PENDING'] },
  },

  'POST /ai/extractions': {
    summary: 'Start reading field values from a file for a new record (AI)',
    description:
      'Multipart with the fields below and a `file` part (text, CSV or Markdown in this release; ' +
      'at most `AI_EXTRACTION_MAX_FILE_MB`). Refused before any byte is stored when AI is off, ' +
      'you may not create records, or you already have too many automatic fills open. Nothing ' +
      'becomes record metadata until you confirm. Every 429 carries `details.retryAfterSeconds`.',
    access: 'records.write',
    scope: 'personal',
    response: 'The job (`queued`); poll it until it is no longer queued or processing',
    multipart: StartExtractionSchema,
    errors: {
      404: ['NOT_FOUND'],
      409: [
        'CONTENT_TYPE_ARCHIVED',
        'CONTENT_TYPE_DELETING',
        'AI_EXTRACTION_OFF',
        'NO_FILLABLE_FIELDS',
      ],
      413: ['FILE_TOO_LARGE'],
      415: ['UNSUPPORTED_FILE'],
      429: ['AI_EXTRACTION_BUSY', 'AI_EXTRACTION_USER_LIMIT', 'AI_EXTRACTION_TENANT_LIMIT'],
      503: ['AI_DISABLED'],
    },
  },
  'GET /ai/extractions/{id}': {
    summary: 'One of your automatic fills: status, stage and the validated suggestions',
    access: 'signed-in',
    scope: 'personal',
    response:
      '`{ id, status, stage, contentTypeId, schemaVersion, file, text, fields, errorCode, errorReason, retryable, recordId, expiresAt }`',
  },
  'POST /ai/extractions/{id}/confirm': {
    summary: 'Create the record from the staged file with your final values',
    description:
      'JSON, exactly the fields of `POST /records` without the file. Works in every open status ' +
      '(you need not wait for the suggestions). Every check of record creation applies, with your ' +
      'access now. A 409 `EXTRACTION_NOT_CONFIRMABLE` with a `recordId` means the record already ' +
      'exists; without one, it may still be saving: do not create it again.',
    access: 'records.write',
    scope: 'personal',
    response: 'The record (as `POST /records`)',
    errors: {
      404: ['NOT_FOUND'],
      409: [
        'EXTRACTION_NOT_CONFIRMABLE',
        'EXTRACTION_TYPE_MISMATCH',
        'CONTENT_TYPE_ARCHIVED',
        'CONTENT_TYPE_DELETING',
      ],
      503: ['EXTRACTION_CONFIRM_TIMEOUT'],
    },
  },
  'DELETE /ai/extractions/{id}': {
    summary: 'Cancel one of your automatic fills and delete its staged file',
    description: 'Idempotent for a job that already ended. Refused while a save is in progress.',
    access: 'signed-in',
    scope: 'personal',
    response: 'No content',
    errors: { 404: ['NOT_FOUND'], 409: ['EXTRACTION_NOT_CONFIRMABLE'] },
  },
};
