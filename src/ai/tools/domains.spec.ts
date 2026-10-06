import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Principal } from '../../auth/principal.js';
import {
  ALL_TOOLS,
  DOMAINS,
  domainsFor,
  PROPOSALS_BY_TOOL,
  toolsFor,
  validateCatalogue,
  type DomainDef,
} from './domains.js';

const PRINCIPAL: Principal = {
  userId: '9'.repeat(24),
  tenantId: '8'.repeat(24),
  role: 'member',
  email: 'x@example.test',
  displayName: 'X',
};
import { defineTool, type ToolDef } from './tool.js';

const member = { role: 'member' as const };
const admin = { role: 'admin' as const };

const stub = (name: string, domain: ToolDef['domain'] = 'search'): ToolDef =>
  defineTool({
    name,
    domain,
    description: 'stub',
    input: z.object({}).strict(),
    run: () => Promise.resolve({ data: {} }),
  }) as ToolDef;

const domainOf = (tools: ToolDef[], name: DomainDef['name'] = 'search'): DomainDef => ({
  name,
  label: 'x',
  purpose: 'x',
  instructions: 'x',
  tools,
  available: () => true,
});

describe('tool catalogue', () => {
  it('has the read, propose, collab and admin tools', () => {
    expect(DOMAINS.map((domain) => domain.name)).toEqual([
      'search',
      'records',
      'folders',
      'schema',
      'collab',
      'admin',
    ]);
    expect(ALL_TOOLS.map((tool) => tool.name).sort()).toEqual(
      [
        'admin_get_activity_report',
        'admin_get_dashboard',
        'admin_get_overview',
        'admin_list_members',
        'admin_list_trash',
        'admin_propose_restore',
        'admin_search_audit',
        'collab_list_comments',
        'collab_list_relations',
        'collab_propose_comment',
        'collab_propose_delete_comment',
        'collab_propose_favorite',
        'collab_propose_relation',
        'collab_propose_remove_relation',
        'folders_get_folder',
        'folders_get_tree',
        'folders_propose_create',
        'folders_propose_move',
        'folders_propose_rename',
        'folders_propose_trash',
        'records_get_record',
        'records_list_versions',
        'records_propose_checkin',
        'records_propose_checkout',
        'records_propose_create',
        'records_propose_move',
        'records_propose_new_version',
        'records_propose_rename',
        'records_propose_restore_version',
        'records_propose_set_tags',
        'records_propose_trash',
        'schema_get_content_type',
        'schema_list_content_types',
        'schema_propose_archive',
        'schema_propose_create_type',
        'schema_propose_update_fields',
        'search_list_my',
        'search_list_saved',
        'search_list_tags',
        'search_run_saved',
        'search_search_records',
      ].sort(),
    );
  });

  it('gives every domain at most 14 tools, and every proposal an executor', () => {
    for (const domain of DOMAINS) expect(domain.tools.length, domain.name).toBeLessThanOrEqual(14);
    const proposing = ALL_TOOLS.filter((tool) => tool.name.includes('_propose_')).map(
      (tool) => tool.name,
    );
    expect([...PROPOSALS_BY_TOOL.keys()].sort()).toEqual(proposing.sort());
  });

  it('labels every confirm button by the kind of change', () => {
    expect(
      Object.fromEntries(
        [...PROPOSALS_BY_TOOL].map(([tool, proposal]) => [tool, proposal.confirmLabel]),
      ),
    ).toEqual({
      records_propose_create: 'create',
      records_propose_new_version: 'update',
      records_propose_rename: 'update',
      records_propose_move: 'move',
      records_propose_set_tags: 'update',
      records_propose_restore_version: 'update',
      records_propose_checkout: 'confirm',
      records_propose_checkin: 'confirm',
      records_propose_trash: 'trash',
      folders_propose_create: 'create',
      folders_propose_rename: 'update',
      folders_propose_move: 'move',
      folders_propose_trash: 'trash',
      schema_propose_create_type: 'create',
      schema_propose_update_fields: 'update',
      schema_propose_archive: 'update',
      collab_propose_comment: 'create',
      collab_propose_delete_comment: 'delete',
      collab_propose_relation: 'create',
      collab_propose_remove_relation: 'remove',
      collab_propose_favorite: 'confirm',
      admin_propose_restore: 'confirm',
    });
  });

  it('offers members no schema write, and admins all of them', () => {
    const schema = DOMAINS.find((domain) => domain.name === 'schema') as DomainDef;
    const names = (principal: Principal) => toolsFor(schema, principal).map((tool) => tool.name);
    expect(
      names({ ...PRINCIPAL, role: 'member' }).filter((name) => name.includes('_propose_')),
    ).toEqual([]);
    expect(names({ ...PRINCIPAL, role: 'admin' })).toContain('schema_propose_update_fields');
  });

  it('passes its own start-up validation', () => {
    expect(() => validateCatalogue(DOMAINS, ALL_TOOLS)).not.toThrow();
  });

  it('refuses an invalid, duplicate, misplaced or homeless tool', () => {
    expect(() => validateCatalogue([domainOf([stub('searchRecords')])], [])).toThrow(/name/);
    expect(() => validateCatalogue([domainOf([stub('search_find_records')])], [])).toThrow(/name/);
    const twice = stub('search_list_tags');
    expect(() => validateCatalogue([domainOf([twice, stub('search_list_tags')])], [])).toThrow(
      /duplicate/i,
    );
    expect(() =>
      validateCatalogue([domainOf([stub('records_get_record', 'records')])], []),
    ).toThrow(/domain/);
    const homeless = stub('search_list_things');
    expect(() => validateCatalogue([domainOf([])], [homeless])).toThrow(/in no domain/);
  });

  it('gives members no admin domain, and admins every domain', () => {
    expect(domainsFor(member).map((domain) => domain.name)).toEqual([
      'search',
      'records',
      'folders',
      'schema',
      'collab',
    ]);
    expect(domainsFor(admin).map((domain) => domain.name)).toEqual([
      ...domainsFor(member).map((domain) => domain.name),
      'admin',
    ]);
  });

  it('marks the collab deletes destructive and the relation add reviewed on its own', () => {
    expect(PROPOSALS_BY_TOOL.get('collab_propose_delete_comment')?.confirmLabel).toBe('delete');
    expect(PROPOSALS_BY_TOOL.get('collab_propose_remove_relation')?.confirmLabel).toBe('remove');
  });

  it('has flat model-facing input schemas: no oneOf, and anyOf only for nullable values', () => {
    const walk = (schema: unknown, path: string): void => {
      if (schema === null || typeof schema !== 'object') return;
      const node = schema as Record<string, unknown>;
      expect(node.oneOf, `${path} uses oneOf`).toBeUndefined();
      if (Array.isArray(node.anyOf)) {
        const variants = node.anyOf as Array<Record<string, unknown>>;
        expect(variants, `${path} is a union`).toHaveLength(2);
        expect(
          variants.some((variant) => variant.type === 'null'),
          `${path} is a union`,
        ).toBe(true);
      }
      for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
    };
    for (const tool of ALL_TOOLS) walk(z.toJSONSchema(tool.input), tool.name);
  });

  it('never imports a repository into the tool layer', () => {
    const dir = import.meta.dirname;
    const sources = readdirSync(dir).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'),
    );
    expect(sources.length).toBeGreaterThan(4);
    for (const file of sources) {
      const text = readFileSync(join(dir, file), 'utf8');
      expect(text, file).not.toMatch(/\b[A-Z]\w*Repository\b/);
      expect(text, file).not.toMatch(/from '[^']*repository(\.js)?'/i);
    }
  });
});
