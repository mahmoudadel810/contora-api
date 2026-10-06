import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AccessService } from '../access/access.service.js';
import { AuthService } from '../auth/auth.service.js';
import type { Principal } from '../auth/principal.js';
import { CommentsService } from '../comments/comments.service.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { ContentTypeBodySchema } from '../content-types/content-types.dto.js';
import { ContentTypesService } from '../content-types/content-types.service.js';
import { FoldersService } from '../folders/folders.service.js';
import { InvitationsService } from '../members/invitations.service.js';
import { MembersService } from '../members/members.service.js';
import { MyRecordsService } from '../my-records/my-records.service.js';
import { RecordsRepository } from '../records/records.repository.js';
import { RecordsService } from '../records/records.service.js';
import { RelationsService } from '../relations/relations.service.js';
import { SavedSearchesService } from '../saved-searches/saved-searches.service.js';
import type { UploadedFile } from '../storage/blobs.service.js';
import { TrashService } from '../trash/trash.service.js';
import type { UserDocument } from '../users/user.schema.js';
import { UsersRepository } from '../users/users.repository.js';
import {
  DEMO_ADMIN,
  DEMO_FOLDERS,
  DEMO_INVITEE,
  DEMO_MEMBER,
  DEMO_MEMBER_GRANTS,
  DEMO_PASSWORD,
  DEMO_RECORDS,
  DEMO_RELATIONS,
  DEMO_REMOVED,
  DEMO_SUSPENDED,
  DEMO_TENANT,
  DEMO_TYPES,
  type DemoRecord,
} from './demo-data.js';
import { fieldsToAppend } from './type-fields.js';

export interface SeedSummary {
  created: boolean;
  tenant: string;
  accounts: string[];
  added: string[];
}

type Person = 'admin' | 'member';
type People = Record<Person, Principal>;

function withPeople(metadata: Record<string, unknown>, people: People): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      value === '@admin' || value === '@member' ? people[value.slice(1) as Person].userId : value,
    ]),
  );
}

function withMentions(body: string, people: People): string {
  return body.replace(
    /@\{(admin|member)\}/g,
    (_placeholder, who: Person) => `@{user:${people[who].userId}}`,
  );
}

function principalOf(user: UserDocument): Principal {
  return {
    userId: user.id as string,
    tenantId: user.tenantId.toHexString(),
    role: user.role,
    email: user.email,
    displayName: user.displayName,
  };
}

@Injectable()
export class SeedService {
  private readonly logger = new Logger('Seed');

  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersRepository,
    private readonly contentTypes: ContentTypesService,
    private readonly folders: FoldersService,
    private readonly records: RecordsService,
    private readonly recordsRepository: RecordsRepository,
    private readonly myRecords: MyRecordsService,
    private readonly savedSearches: SavedSearchesService,
    private readonly comments: CommentsService,
    private readonly relations: RelationsService,
    private readonly trash: TrashService,
    private readonly members: MembersService,
    private readonly invitations: InvitationsService,
    private readonly access: AccessService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async run(): Promise<SeedSummary> {
    const added: string[] = [];
    let adminUser = await this.users.findByEmailAcrossTenants(DEMO_ADMIN.email);
    const created = adminUser === null;
    if (!adminUser) {
      await this.auth.signUp({
        tenantName: DEMO_TENANT,
        displayName: DEMO_ADMIN.displayName,
        email: DEMO_ADMIN.email,
        password: DEMO_PASSWORD,
      });
      adminUser = await this.users.findByEmailAcrossTenants(DEMO_ADMIN.email);
      if (!adminUser) throw new Error('Demo admin was not created');
      added.push(`tenant ${DEMO_TENANT}`);
    }
    const tenantId = adminUser.tenantId.toHexString();
    const admin = principalOf(adminUser);
    const memberUser = await this.ensureUser(tenantId, DEMO_MEMBER, added);
    const typeIds = await this.ensureTypes(admin, added);
    const folderIds = await this.ensureFolders(admin, added);
    await this.ensureGrants(admin, memberUser, 'folder', folderIds, added);
    const people: People = { admin, member: principalOf(memberUser) };
    const recordIds = await this.ensureRecords(people, typeIds, folderIds, added);
    await this.ensureGrants(admin, memberUser, 'record', recordIds, added);
    await this.ensureRelations(admin, recordIds, added);
    await this.ensureSavedSearches(admin, typeIds, added);
    await this.ensureMemberStatuses(tenantId, admin, added);
    await this.ensureInvitation(admin, added);

    if (!created) {
      this.logger.log(
        added.length === 0
          ? 'Demo tenant already complete; nothing to do'
          : `Topped up the demo tenant: ${added.join('; ')}`,
      );
    }
    return {
      created,
      tenant: DEMO_TENANT,
      accounts: [DEMO_ADMIN.email, DEMO_MEMBER.email],
      added,
    };
  }

  private async ensureUser(
    tenantId: string,
    person: { email: string; displayName: string },
    added: string[],
  ): Promise<UserDocument> {
    const existing = await this.users.findByEmailAcrossTenants(person.email);
    if (existing) {
      if (!existing.tenantId.equals(tenantId)) {
        throw new Error(`${person.email} belongs to another tenant; not seeding over it`);
      }
      return existing;
    }
    added.push(`member ${person.email}`);
    return this.auth.createMember(tenantId, {
      email: person.email,
      password: DEMO_PASSWORD,
      displayName: person.displayName,
      role: 'member',
    });
  }

  private async ensureGrants(
    admin: Principal,
    member: UserDocument,
    targetType: 'folder' | 'record',
    ids: Map<string, string>,
    added: string[],
  ): Promise<void> {
    const existing = await this.access.listForUser(admin, member.id as string);
    for (const grant of DEMO_MEMBER_GRANTS) {
      const key = 'folder' in grant ? grant.folder : grant.record;
      if (('folder' in grant ? 'folder' : 'record') !== targetType) continue;
      const targetId = ids.get(key);
      if (!targetId) continue;
      const held = existing.find((g) => g.targetType === targetType && g.targetId === targetId);
      if (held && (held.level === grant.level || held.level === 'edit')) continue;
      await this.access.put(admin, {
        userId: member.id as string,
        targetType,
        targetId,
        level: grant.level,
      });
      added.push(`${grant.level} grant on ${targetType} ${key} for ${member.email}`);
    }
  }

  private async ensureTypes(admin: Principal, added: string[]): Promise<Map<string, string>> {
    const existing = await this.contentTypes.list(admin, { status: 'all' });
    const typeIds = new Map<string, string>();
    for (const demo of DEMO_TYPES) {
      const found = existing.find((t) => t.name.toLowerCase() === demo.name.toLowerCase());
      if (!found) {
        typeIds.set(demo.name, (await this.contentTypes.create(admin, demo)).id);
        added.push(`content type ${demo.name}`);
        continue;
      }
      typeIds.set(demo.name, found.id);
      const missing = fieldsToAppend(found.name, found.fields, demo.fields);
      if (missing.length === 0) continue;
      const body = ContentTypeBodySchema.parse({
        name: found.name,
        description: found.description,
        fields: [...found.fields, ...missing],
      });
      await this.contentTypes.update(admin, found.id, body);
      added.push(`fields ${missing.map((f) => f.key).join(', ')} on ${found.name}`);
    }
    return typeIds;
  }

  private async ensureFolders(admin: Principal, added: string[]): Promise<Map<string, string>> {
    const root = await this.folders.ensureRoot(admin);
    const tree = await this.folders.tree(admin);
    const folderIds = new Map<string, string>([['', root.id as string]]);
    for (const path of DEMO_FOLDERS) {
      const segments = path.split('/');
      const parentId = folderIds.get(segments.slice(0, -1).join('/')) as string;
      const name = segments[segments.length - 1];
      const found = tree.find((f) => f.parentId === parentId && f.name === name);
      if (found) {
        folderIds.set(path, found.id);
        continue;
      }
      folderIds.set(path, (await this.folders.create(admin, { name, parentId })).id);
      added.push(`folder ${path}`);
    }
    return folderIds;
  }

  private async ensureRecords(
    people: People,
    typeIds: Map<string, string>,
    folderIds: Map<string, string>,
    added: string[],
  ): Promise<Map<string, string>> {
    const recordIds = new Map<string, string>();
    const viewedByAdmin = new Set(
      (await this.myRecords.listRecent(people.admin)).map((r) => r.record.id),
    );
    for (const demo of DEMO_RECORDS) {
      const existing = await this.recordsRepository.findOne(people.admin.tenantId, {
        name: demo.name,
      });
      if (existing) {
        if (existing.deletedAt === null) {
          recordIds.set(demo.name, existing.id as string);
          await this.ensureRecordExtras(people, demo, existing.id as string, viewedByAdmin, added);
        }
        continue;
      }
      const id = await this.createRecord(people, demo, typeIds, folderIds);
      added.push(`record ${demo.name}`);
      if (demo.trashedBy) {
        await this.trash.trashRecord(people[demo.trashedBy], id);
        continue;
      }
      recordIds.set(demo.name, id);
      await this.ensureRecordExtras(people, demo, id, viewedByAdmin, added);
    }
    return recordIds;
  }

  private async createRecord(
    people: People,
    demo: DemoRecord,
    typeIds: Map<string, string>,
    folderIds: Map<string, string>,
  ): Promise<string> {
    const record = await this.records.create(
      people[demo.by],
      {
        name: demo.name,
        contentTypeId: typeIds.get(demo.type) as string,
        folderId: folderIds.get(demo.folder) as string,
        metadata: withPeople(demo.metadata, people),
        comment: 'Initial upload',
        tags: demo.tags,
      },
      demo.file ? await this.stage(demo.file) : null,
    );
    for (const version of demo.versions) {
      await this.records.addVersion(
        people[version.by],
        record.id,
        {
          metadata: version.metadata && withPeople(version.metadata, people),
          comment: version.comment,
        },
        version.file ? await this.stage(version.file) : null,
      );
    }
    if (demo.checkedOutBy) await this.records.checkOut(people[demo.checkedOutBy], record.id);
    return record.id;
  }

  private async ensureRecordExtras(
    people: People,
    demo: DemoRecord,
    recordId: string,
    viewedByAdmin: Set<string>,
    added: string[],
  ): Promise<void> {
    for (const who of demo.favoriteOf ?? []) {
      if (await this.myRecords.isFavorite(people[who], recordId)) continue;
      await this.myRecords.addFavorite(people[who], recordId);
      added.push(`favorite ${demo.name} for ${people[who].email}`);
    }
    if (!viewedByAdmin.has(recordId)) {
      await this.myRecords.recordView(people.admin, recordId);
      viewedByAdmin.add(recordId);
      added.push(`recently viewed ${demo.name}`);
    }
    if (!demo.comments?.length) return;
    const present = await this.comments.list(people.admin, recordId);
    for (const comment of demo.comments) {
      const author = people[comment.by];
      const body = withMentions(comment.body, people);
      if (present.some((c) => c.author.id === author.userId && c.body === body)) continue;
      await this.comments.add(author, recordId, body);
      added.push(`comment on ${demo.name} by ${author.email}`);
    }
  }

  private async ensureRelations(
    admin: Principal,
    recordIds: Map<string, string>,
    added: string[],
  ): Promise<void> {
    for (const relation of DEMO_RELATIONS) {
      const fromId = recordIds.get(relation.from);
      const toId = recordIds.get(relation.to);
      if (!fromId || !toId) continue;
      const present = await this.relations.list(admin, fromId);
      const exists = present.items.some(
        (r) => r.kind === relation.kind && r.direction === 'outgoing' && r.other.id === toId,
      );
      if (exists) continue;
      await this.relations.add(admin, fromId, {
        kind: relation.kind,
        otherId: toId,
        direction: 'outgoing',
      });
      added.push(`relation ${relation.from} ${relation.kind} ${relation.to}`);
    }
  }

  private async ensureSavedSearches(
    admin: Principal,
    typeIds: Map<string, string>,
    added: string[],
  ): Promise<void> {
    const demo = [
      {
        name: 'Open invoices',
        criteria: {
          contentTypeId: typeIds.get('Invoice'),
          metaKey: 'status',
          metaValue: 'Open',
          dateField: 'updatedAt' as const,
        },
      },
      {
        name: 'Contracts up for renewal',
        criteria: { tags: ['renewal'], dateField: 'updatedAt' as const },
      },
    ];
    const names = new Set((await this.savedSearches.list(admin)).map((s) => s.name));
    for (const search of demo) {
      if (names.has(search.name)) continue;
      await this.savedSearches.create(admin, search);
      added.push(`saved search ${search.name}`);
    }
  }

  private async ensureMemberStatuses(
    tenantId: string,
    admin: Principal,
    added: string[],
  ): Promise<void> {
    if (!(await this.users.emailTaken(DEMO_SUSPENDED.email))) {
      const carol = await this.ensureUser(tenantId, DEMO_SUSPENDED, added);
      await this.members.suspend(admin, carol.id as string);
    }
    if (!(await this.users.emailTaken(DEMO_REMOVED.email))) {
      const dan = await this.ensureUser(tenantId, DEMO_REMOVED, added);
      await this.members.remove(admin, dan.id as string);
    }
  }

  private async ensureInvitation(admin: Principal, added: string[]): Promise<void> {
    if (await this.users.emailTaken(DEMO_INVITEE.email)) return;
    const pending = (await this.invitations.list(admin)).some(
      (i) => i.email === DEMO_INVITEE.email && i.status === 'pending',
    );
    if (pending) return;
    await this.invitations.create(admin, DEMO_INVITEE.email, DEMO_INVITEE.role);
    added.push(`invitation ${DEMO_INVITEE.email}`);
  }

  private async stage(file: {
    name: string;
    mimeType: string;
    content: string;
  }): Promise<UploadedFile> {
    const dir = join(this.config.STORAGE_DIR, 'tmp');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `seed-${randomUUID()}`);
    await writeFile(path, file.content);
    return { path, originalName: file.name, mimeType: file.mimeType };
  }
}
