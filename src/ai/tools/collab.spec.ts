import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '../../auth/principal.js';
import type { BlockDraft } from '../blocks.js';
import {
  collabProposeComment,
  collabProposeDeleteComment,
  collabProposeFavorite,
  collabProposeRelation,
  collabProposeRemoveRelation,
} from './collab.proposals.js';
import { COLLAB_TOOLS } from './collab.tools.js';
import type { ExecuteContext } from './proposal.js';
import { runTool, type ToolContext, type ToolDef, type ToolServices } from './tool.js';

const RECORD = 'a'.repeat(24);
const OTHER = 'b'.repeat(24);
const MINE = 'c'.repeat(24);
const THEIRS = 'd'.repeat(24);
const RELATION = 'e'.repeat(24);
const FOLDER = 'f'.repeat(24);

const me: Principal = {
  userId: '9'.repeat(24),
  tenantId: '8'.repeat(24),
  role: 'admin',
  email: 'me@example.test',
  displayName: 'Me',
};

function fakeServices() {
  return {
    access: {
      requireRecord: vi.fn(async (_p: Principal, id: string) => ({
        id,
        name: id === OTHER ? 'Other record' : 'Main record',
      })),
    },
    comments: {
      list: vi.fn(async () => [
        {
          id: MINE,
          body: 'My note',
          author: { id: me.userId, displayName: 'Me' },
          createdAt: 't1',
        },
        {
          id: THEIRS,
          body: 'Their note',
          author: { id: '7'.repeat(24), displayName: 'Bob' },
          createdAt: 't2',
        },
      ]),
      add: vi.fn(async () => ({})),
      remove: vi.fn(async () => undefined),
    },
    relations: {
      list: vi.fn(async () => ({
        total: 1,
        items: [
          {
            id: RELATION,
            kind: 'references',
            direction: 'outgoing',
            label: 'References',
            other: {
              id: OTHER,
              name: 'Other record',
              contentTypeName: null,
              folderId: FOLDER,
              folderPath: [{ id: FOLDER, name: 'Finance' }],
            },
            createdBy: { id: me.userId, displayName: 'Me' },
            createdAt: 't',
          },
        ],
      })),
      add: vi.fn(async () => ({})),
      remove: vi.fn(async () => undefined),
    },
    myRecords: {
      isFavorite: vi.fn(async () => false),
      addFavorite: vi.fn(async () => undefined),
      removeFavorite: vi.fn(async () => undefined),
    },
  };
}

type Fakes = ReturnType<typeof fakeServices>;

const checkCtx = (services: Fakes, principal = me) => ({
  principal,
  services: services as unknown as ToolServices,
  planned: () => null,
});

const executeCtx = (services: Fakes, principal = me): ExecuteContext => ({
  principal,
  services: services as unknown as ToolServices,
  file: null,
  resolved: () => {
    throw new Error('no refs');
  },
});

function toolCtx(services: Fakes, emitted: BlockDraft[]): ToolContext {
  return {
    ...checkCtx(services),
    signal: new AbortController().signal,
    sessionId: '1'.repeat(24),
    emit: (block) => {
      emitted.push(block);
      return `b${emitted.length}`;
    },
    propose: () => Promise.reject(new Error('not here')),
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return (error.getResponse() as { code: string }).code;
    throw error;
  }
  throw new Error('expected a refusal');
}

const tool = (name: string) => COLLAB_TOOLS.find((candidate) => candidate.name === name) as ToolDef;

describe('collab read tools', () => {
  it('lists comments after a view check, scoped to the record', async () => {
    const services = fakeServices();
    const emitted: BlockDraft[] = [];
    const value = await runTool(tool('collab_list_comments'), toolCtx(services, emitted), {
      recordId: RECORD,
    });
    expect(services.access.requireRecord).toHaveBeenCalledWith(me, RECORD, 'view');
    expect(value).toMatchObject({
      ok: true,
      data: {
        total: 2,
        items: [
          { id: MINE, own: true },
          { id: THEIRS, own: false, author: 'Bob' },
        ],
      },
    });
    expect(emitted[0]).toMatchObject({
      kind: 'table',
      scope: { domain: 'collab', recordId: RECORD },
    });
  });

  it('lists relations with every other record and folder in the block scope', async () => {
    const emitted: BlockDraft[] = [];
    await runTool(tool('collab_list_relations'), toolCtx(fakeServices(), emitted), {
      recordId: RECORD,
    });
    expect(emitted[0]).toMatchObject({
      kind: 'table',
      rows: [['References', 'Other record', 'Finance']],
      scope: { targets: { records: [OTHER], folders: [FOLDER] } },
    });
  });
});

describe('collab proposals', () => {
  it('comments in the user’s name with the exact text on the card', async () => {
    const services = fakeServices();
    const preview = await collabProposeComment.check(checkCtx(services), {
      recordId: RECORD,
      body: '  Looks good ',
    });
    expect(preview).toMatchObject({
      args: { recordId: RECORD, body: 'Looks good' },
      changes: [{ label: 'Comment', after: 'Looks good' }],
      targets: { records: [RECORD], folders: [] },
    });
    expect(services.comments.add).not.toHaveBeenCalled();
    await collabProposeComment.execute(executeCtx(services), preview.args, null);
    expect(services.comments.add).toHaveBeenCalledWith(me, RECORD, 'Looks good');
  });

  it('deletes only the user’s own comment, even for an admin, checked again at confirm', async () => {
    const services = fakeServices();
    const preview = await collabProposeDeleteComment.check(checkCtx(services), {
      recordId: RECORD,
      commentId: MINE,
    });
    expect(preview).toMatchObject({ destructive: true });
    expect(
      await codeOf(
        collabProposeDeleteComment.check(checkCtx(services), {
          recordId: RECORD,
          commentId: THEIRS,
        }),
      ),
    ).toBe('COMMENT_NOT_OWN');
    expect(
      await codeOf(
        collabProposeDeleteComment.execute(
          executeCtx(services),
          { recordId: RECORD, commentId: THEIRS },
          null,
        ),
      ),
    ).toBe('COMMENT_NOT_OWN');
    expect(services.comments.remove).not.toHaveBeenCalled();
    await collabProposeDeleteComment.execute(
      executeCtx(services),
      { recordId: RECORD, commentId: MINE },
      null,
    );
    expect(services.comments.remove).toHaveBeenCalledWith(me, RECORD, MINE);
  });

  it('adds a relation (edit on the record, view on the other), reviewed on its own', async () => {
    const services = fakeServices();
    const preview = await collabProposeRelation.check(checkCtx(services), {
      recordId: RECORD,
      otherId: OTHER,
      kind: 'supersedes',
      direction: null,
    });
    expect(services.access.requireRecord).toHaveBeenCalledWith(me, RECORD, 'edit');
    expect(services.access.requireRecord).toHaveBeenCalledWith(me, OTHER, 'view');
    expect(preview).toMatchObject({
      reviewEach: true,
      args: { direction: 'outgoing', kind: 'supersedes' },
      targets: { records: [RECORD, OTHER], folders: [] },
    });
    expect(
      await codeOf(
        collabProposeRelation.check(checkCtx(services), {
          recordId: RECORD,
          otherId: RECORD,
          kind: 'relatedTo',
          direction: null,
        }),
      ),
    ).toBe('SELF_RELATION');
    await collabProposeRelation.execute(executeCtx(services), preview.args, null);
    expect(services.relations.add).toHaveBeenCalledWith(me, RECORD, {
      kind: 'supersedes',
      otherId: OTHER,
      direction: 'outgoing',
    });
  });

  it('removes a listed relation (destructive) and refuses an unknown one', async () => {
    const services = fakeServices();
    const preview = await collabProposeRemoveRelation.check(checkCtx(services), {
      recordId: RECORD,
      relationId: RELATION,
    });
    expect(preview).toMatchObject({
      destructive: true,
      changes: [{ label: 'References', before: 'Other record' }],
    });
    expect(
      await codeOf(
        collabProposeRemoveRelation.check(checkCtx(services), {
          recordId: RECORD,
          relationId: OTHER,
        }),
      ),
    ).toBe('NOT_FOUND');
    await collabProposeRemoveRelation.execute(executeCtx(services), preview.args, null);
    expect(services.relations.remove).toHaveBeenCalledWith(me, RECORD, RELATION);
  });

  it('favorites without a tenant audit entry (personal data), and refuses a no-op', async () => {
    const services = fakeServices();
    expect(
      await codeOf(
        collabProposeFavorite.check(checkCtx(services), { recordId: RECORD, favorite: false }),
      ),
    ).toBe('NOTHING_TO_CHANGE');
    const done = await collabProposeFavorite.execute(
      executeCtx(services),
      { recordId: RECORD, favorite: true },
      null,
    );
    expect(services.myRecords.addFavorite).toHaveBeenCalledWith(me, RECORD);
    expect(done.resource).toBeNull();
  });
});
