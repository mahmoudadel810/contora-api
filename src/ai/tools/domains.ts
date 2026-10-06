import type { Principal } from '../../auth/principal.js';
import { can } from '../../authorization/policy.js';
import { ADMIN_PROPOSALS } from './admin.proposals.js';
import { ADMIN_TOOLS } from './admin.tools.js';
import { COLLAB_PROPOSALS } from './collab.proposals.js';
import { COLLAB_TOOLS } from './collab.tools.js';
import { FOLDERS_PROPOSALS } from './folders.proposals.js';
import { FOLDERS_TOOLS } from './folders.tools.js';
import { proposalTool, type Proposal } from './proposal.js';
import { RECORDS_PROPOSALS } from './records.proposals.js';
import { RECORDS_TOOLS } from './records.tools.js';
import { SCHEMA_PROPOSALS } from './schema.proposals.js';
import { SCHEMA_TOOLS } from './schema.tools.js';
import { SEARCH_TOOLS } from './search.tools.js';
import { DOMAIN_NAMES, type DomainName, type ToolDef } from './tool.js';

export interface DomainDef {
  name: DomainName;
  label: string;
  purpose: string;
  instructions: string;
  tools: ToolDef[];
  available(principal: Pick<Principal, 'role'>): boolean;
}

const everyone = () => true;

const PROPOSING =
  'To change something, call the matching propose tool: it only prepares a card that the user confirms or cancels; nothing changes until they do. Never say a change is done. If a required value is missing or the request is ambiguous, ask one focused question instead of proposing with guessed values. Report refusals as returned.';

export const DOMAINS: DomainDef[] = [
  {
    name: 'search',
    label: 'Searching records…',
    purpose:
      'find records by text, content type, folder, tag, date or metadata; tags; saved searches; favorites and recently viewed',
    instructions:
      'Find records for the task. Prefer one precise search (use content type ids and field keys from the task) over many broad ones. Report totals honestly; if nothing matched, say so.',
    tools: SEARCH_TOOLS,
    available: everyone,
  },
  {
    name: 'records',
    label: 'Reading the record…',
    purpose:
      'one record: details, metadata values, versions, check-out state, file; propose creating records, new versions, rename, move, tags, restoring a version, check-out, check-in, trash',
    instructions: `Read the record(s) named in the task by id and answer about them. Quote values exactly as returned. ${PROPOSING}`,
    tools: [...RECORDS_TOOLS, ...RECORDS_PROPOSALS.map(proposalTool)],
    available: everyone,
  },
  {
    name: 'folders',
    label: 'Looking through folders…',
    purpose:
      'the folder tree, and one folder with its subfolders and records; propose creating, renaming, moving or trashing folders',
    instructions: `Answer about folders and what they contain. A null folder id is the root. ${PROPOSING}`,
    tools: [...FOLDERS_TOOLS, ...FOLDERS_PROPOSALS.map(proposalTool)],
    available: everyone,
  },
  {
    name: 'schema',
    label: 'Reading content types…',
    purpose:
      'content types (metadata schemas) and their fields; admins: propose creating a type, adding, relabelling, reordering or requiring fields, archiving',
    instructions: `Answer about content types and their fields, keys and constraints. Only admins have the propose tools. ${PROPOSING}`,
    tools: [...SCHEMA_TOOLS, ...SCHEMA_PROPOSALS.map(proposalTool)],
    available: everyone,
  },
  {
    name: 'collab',
    label: 'Looking at comments and relations…',
    purpose:
      'comments and relations of a record; propose adding a comment, deleting your own comment, adding or removing a relation, favoriting',
    instructions: `Answer about comments and relations of the records in the task. Only the user's own comments can be deleted. ${PROPOSING}`,
    tools: [...COLLAB_TOOLS, ...COLLAB_PROPOSALS.map(proposalTool)],
    available: everyone,
  },
  {
    name: 'admin',
    label: 'Checking the workspace…',
    purpose:
      'admins only: dashboard and overview counts, the audit log, the activity report, members, the trash; propose restoring from the trash',
    instructions: `Answer about the workspace as a whole. Never mention email addresses. ${PROPOSING}`,
    tools: [...ADMIN_TOOLS, ...ADMIN_PROPOSALS.map(proposalTool)],
    available: (principal) => can(principal, 'admin.overview'),
  },
];

export const ALL_TOOLS: ToolDef[] = DOMAINS.flatMap((domain) => domain.tools);

export const ALL_PROPOSALS: Proposal[] = [
  ...RECORDS_PROPOSALS,
  ...FOLDERS_PROPOSALS,
  ...SCHEMA_PROPOSALS,
  ...COLLAB_PROPOSALS,
  ...ADMIN_PROPOSALS,
];

export const PROPOSALS_BY_TOOL: ReadonlyMap<string, Proposal> = new Map(
  ALL_PROPOSALS.map((proposal) => [proposal.tool, proposal]),
);

const TOOL_NAME = new RegExp(
  `^(${DOMAIN_NAMES.join('|')})_(get|list|search|run|propose)_[a-z][a-z0-9]*(_[a-z0-9]+)*$`,
);

export function validateCatalogue(domains: DomainDef[], tools: ToolDef[]): void {
  const seen = new Set<string>();
  const placed = new Set<ToolDef>();
  for (const domain of domains) {
    for (const tool of domain.tools) {
      if (!TOOL_NAME.test(tool.name)) {
        throw new Error(`AI tool name "${tool.name}" is not <domain>_<verb>_<object>`);
      }
      if (seen.has(tool.name)) throw new Error(`Duplicate AI tool name "${tool.name}"`);
      if (tool.domain !== domain.name || !tool.name.startsWith(`${domain.name}_`)) {
        throw new Error(`AI tool "${tool.name}" is not in its own domain "${domain.name}"`);
      }
      seen.add(tool.name);
      placed.add(tool);
    }
  }
  for (const tool of tools) {
    if (!placed.has(tool)) throw new Error(`AI tool "${tool.name}" is in no domain`);
  }
}

export function domainsFor(principal: Pick<Principal, 'role'>): DomainDef[] {
  return DOMAINS.filter((domain) => domain.available(principal));
}

export function toolsFor(domain: DomainDef, principal: Principal): ToolDef[] {
  return domain.tools.filter((tool) => tool.available?.(principal) ?? true);
}
