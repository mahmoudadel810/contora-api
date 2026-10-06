import type { FieldDefinition } from '../content-types/field-types.js';
import type { RelationKind } from '../relations/relation-kinds.js';

export const DEMO_PASSWORD = 'Demo1234!';
export const DEMO_TENANT = 'Acme Corp';
export const DEMO_ADMIN = { email: 'alice@acme.demo', displayName: 'Alice Admin' };
export const DEMO_MEMBER = { email: 'bob@acme.demo', displayName: 'Bob Member' };
export const DEMO_SUSPENDED = { email: 'carol@acme.demo', displayName: 'Carol Contractor' };
export const DEMO_REMOVED = { email: 'dan@acme.demo', displayName: 'Dan Former' };
export const DEMO_INVITEE = { email: 'erin@acme.demo', role: 'member' } as const;

export interface DemoType {
  name: string;
  description: string;
  fields: FieldDefinition[];
  aiExtraction?: boolean;
}

export interface DemoVersion {
  by: 'admin' | 'member';
  comment: string;
  metadata?: Record<string, unknown>;
  file?: { name: string; mimeType: string; content: string };
}

export interface DemoRecord {
  name: string;
  type: string;
  folder: string;
  by: 'admin' | 'member';
  metadata: Record<string, unknown>;
  tags: string[];
  file?: { name: string; mimeType: string; content: string };
  versions: DemoVersion[];
  checkedOutBy?: 'admin' | 'member';
  favoriteOf?: ('admin' | 'member')[];
  comments?: { by: 'admin' | 'member'; body: string }[];
  trashedBy?: 'admin' | 'member';
}

export const DEMO_TYPES: DemoType[] = [
  {
    name: 'Invoice',
    description: 'Supplier invoices received by finance',
    aiExtraction: true,
    fields: [
      { key: 'supplier', label: 'Supplier', type: 'text', required: true },
      {
        key: 'invoiceNumber',
        label: 'Invoice number',
        type: 'text',
        required: true,
        maxLength: 40,
      },
      { key: 'amount', label: 'Amount', type: 'number', required: true, min: 0 },
      { key: 'dueDate', label: 'Due date', type: 'date', required: false },
      {
        key: 'status',
        label: 'Status',
        type: 'select',
        required: true,
        options: ['Open', 'Approved', 'Paid', 'Disputed'],
        defaultValue: 'Open',
      },
    ],
  },
  {
    name: 'Contract',
    description: 'Signed and draft agreements',
    aiExtraction: true,
    fields: [
      { key: 'counterparty', label: 'Counterparty', type: 'text', required: true },
      { key: 'value', label: 'Contract value', type: 'number', required: false, min: 0 },
      { key: 'startDate', label: 'Start date', type: 'date', required: false },
      { key: 'signed', label: 'Signed', type: 'boolean', required: false, defaultValue: false },
      { key: 'owner', label: 'Owner email', type: 'email', required: false },
      { key: 'notes', label: 'Notes', type: 'textarea', required: false, maxLength: 2000 },
      {
        key: 'departments',
        label: 'Departments',
        type: 'multiselect',
        required: false,
        options: ['Legal', 'Finance', 'Sales', 'HR'],
      },
      { key: 'portal', label: 'Counterparty portal', type: 'url', required: false },
      { key: 'responsible', label: 'Responsible', type: 'user', required: false },
    ],
  },
  {
    name: 'Site visit',
    description: 'Facility inspections by the operations team',
    fields: [
      { key: 'site', label: 'Site', type: 'text', required: true },
      { key: 'contactPhone', label: 'Contact phone', type: 'phone', required: false },
      { key: 'visitedAt', label: 'Visited at', type: 'datetime', required: false },
      {
        key: 'arrivalTime',
        label: 'Arrival time',
        type: 'time',
        required: false,
        defaultValue: '09:00',
      },
      {
        key: 'travelCost',
        label: 'Travel cost',
        type: 'currency',
        required: false,
        currency: 'EUR',
        min: 0,
      },
      { key: 'completion', label: 'Completion', type: 'percentage', required: false },
      {
        key: 'outcome',
        label: 'Outcome',
        type: 'radio',
        required: false,
        options: ['Resolved', 'Follow-up needed', 'Escalated'],
      },
      {
        key: 'checks',
        label: 'Checks done',
        type: 'checkboxes',
        required: false,
        options: ['Safety', 'Equipment', 'Cleanliness', 'Access'],
      },
    ],
  },
  {
    name: 'Memo',
    description: 'Internal notes and memos',
    fields: [
      { key: 'body', label: 'Body', type: 'textarea', required: true, maxLength: 2000 },
      { key: 'author', label: 'Written by', type: 'text', required: false },
    ],
  },
];

export const DEMO_FOLDERS = [
  'Finance',
  'Finance/Invoices',
  'Finance/Invoices/2026',
  'Legal',
  'Legal/Contracts',
  'HR',
];

const text = (name: string, content: string) => ({ name, mimeType: 'text/plain', content });

const wayneInvoice = (invoiceNumber: string, dueDate: string, status?: string) => ({
  supplier: 'Wayne Enterprises',
  invoiceNumber,
  amount: 62500,
  dueDate,
  ...(status ? { status } : {}),
});

const arabicInvoice = (invoiceNumber: string, amount: number, status?: string) => ({
  supplier: 'مؤسسة أحمد للتجارة',
  invoiceNumber,
  amount,
  dueDate: '2026-11-01',
  ...(status ? { status } : {}),
});

const schoolInvoice = (status?: string) => ({
  supplier: 'مكتبة المدرسة',
  invoiceNumber: 'INV-1024',
  amount: 750,
  dueDate: '2026-10-20',
  ...(status ? { status } : {}),
});

export const DEMO_RECORDS: DemoRecord[] = [
  {
    name: 'Globex invoice INV-2026-001',
    tags: ['finance', 'q3-audit'],
    favoriteOf: ['admin'],
    type: 'Invoice',
    folder: 'Finance/Invoices/2026',
    by: 'member',
    metadata: {
      supplier: 'Globex',
      invoiceNumber: 'INV-2026-001',
      amount: 12500,
      dueDate: '2026-10-15',
    },
    file: text(
      'globex-inv-001.txt',
      'Globex Corporation\nInvoice INV-2026-001\nConsulting services: 12,500.00\n',
    ),
    versions: [
      {
        by: 'member',
        comment: 'Rescanned, first page was cut off',
        file: text(
          'globex-inv-001-rescan.txt',
          'Globex Corporation\nInvoice INV-2026-001\nConsulting services: 12,500.00\nPayment terms: 30 days\n',
        ),
      },
      {
        by: 'admin',
        comment: 'Approved for payment',
        metadata: {
          supplier: 'Globex',
          invoiceNumber: 'INV-2026-001',
          amount: 12500,
          dueDate: '2026-10-15',
          status: 'Approved',
        },
      },
      {
        by: 'admin',
        comment: 'Paid by bank transfer',
        metadata: {
          supplier: 'Globex',
          invoiceNumber: 'INV-2026-001',
          amount: 12500,
          dueDate: '2026-10-15',
          status: 'Paid',
        },
      },
    ],
  },
  {
    name: 'Initech invoice INV-7781',
    tags: ['finance', 'urgent'],
    type: 'Invoice',
    folder: 'Finance/Invoices/2026',
    by: 'member',
    metadata: {
      supplier: 'Initech',
      invoiceNumber: 'INV-7781',
      amount: 980.5,
      dueDate: '2026-09-30',
    },
    file: text('initech-7781.txt', 'Initech\nInvoice 7781\nTPS report binders: 980.50\n'),
    versions: [
      {
        by: 'member',
        comment: 'Amount corrected after credit note',
        metadata: {
          supplier: 'Initech',
          invoiceNumber: 'INV-7781',
          amount: 890.5,
          dueDate: '2026-09-30',
          status: 'Open',
        },
      },
      {
        by: 'member',
        comment: 'Disputed: wrong quantity',
        metadata: {
          supplier: 'Initech',
          invoiceNumber: 'INV-7781',
          amount: 890.5,
          dueDate: '2026-09-30',
          status: 'Disputed',
        },
      },
    ],
    checkedOutBy: 'member',
  },
  {
    name: 'Master services agreement — Wayne Enterprises',
    tags: ['legal', 'renewal'],
    favoriteOf: ['admin', 'member'],
    comments: [{ by: 'member', body: 'Liability cap looks right to me. OK to file as final?' }],
    type: 'Contract',
    folder: 'Legal/Contracts',
    by: 'admin',
    metadata: {
      counterparty: 'Wayne Enterprises',
      value: 250000,
      startDate: '2026-01-01',
      owner: 'alice@acme.demo',
      notes: 'Draft for legal review.',
      departments: ['Legal', 'Finance'],
      portal: 'https://portal.wayne.example/contracts/msa',
      responsible: '@admin',
    },
    file: text(
      'msa-wayne-draft.txt',
      'MASTER SERVICES AGREEMENT\nDraft 1\nBetween Acme Corp and Wayne Enterprises\n',
    ),
    versions: [
      {
        by: 'admin',
        comment: 'Legal comments incorporated',
        file: text(
          'msa-wayne-draft2.txt',
          'MASTER SERVICES AGREEMENT\nDraft 2\nBetween Acme Corp and Wayne Enterprises\nLiability capped at contract value.\n',
        ),
      },
      {
        by: 'admin',
        comment: 'Signed by both parties',
        metadata: {
          counterparty: 'Wayne Enterprises',
          value: 250000,
          startDate: '2026-01-01',
          signed: true,
          owner: 'alice@acme.demo',
          notes: 'Renews annually unless terminated with 90 days notice.',
          departments: ['Legal', 'Finance'],
          portal: 'https://portal.wayne.example/contracts/msa',
          responsible: '@admin',
        },
        file: text(
          'msa-wayne-signed.txt',
          'MASTER SERVICES AGREEMENT\nFinal, signed 2025-12-18\nBetween Acme Corp and Wayne Enterprises\n',
        ),
      },
    ],
  },
  {
    name: 'NDA — Stark Industries',
    tags: ['legal'],
    comments: [
      { by: 'admin', body: 'Countersigned copy filed; @{member} please send it to Stark.' },
    ],
    type: 'Contract',
    folder: 'Legal/Contracts',
    by: 'member',
    metadata: {
      counterparty: 'Stark Industries',
      startDate: '2026-03-01',
      owner: 'bob@acme.demo',
      departments: ['Legal'],
      responsible: '@member',
    },
    file: text(
      'nda-stark.txt',
      'MUTUAL NON-DISCLOSURE AGREEMENT\nAcme Corp and Stark Industries\n',
    ),
    versions: [
      {
        by: 'member',
        comment: 'Counterparty redlines',
        file: text(
          'nda-stark-redline.txt',
          'MUTUAL NON-DISCLOSURE AGREEMENT\nAcme Corp and Stark Industries\nTerm: 3 years\n',
        ),
      },
      {
        by: 'admin',
        comment: 'Countersigned',
        metadata: {
          counterparty: 'Stark Industries',
          startDate: '2026-03-01',
          signed: true,
          owner: 'bob@acme.demo',
          departments: ['Legal', 'Sales'],
          responsible: '@member',
        },
      },
    ],
  },
  {
    name: 'Wayne invoice WE-2026-01',
    tags: ['finance'],
    type: 'Invoice',
    folder: 'Finance/Invoices/2026',
    by: 'member',
    metadata: wayneInvoice('WE-2026-01', '2026-02-15'),
    file: text(
      'wayne-we-2026-01.txt',
      'Wayne Enterprises\nInvoice WE-2026-01\nMaster services agreement, Q1 fee: 62,500.00\n',
    ),
    versions: [
      {
        by: 'admin',
        comment: 'Approved for payment',
        metadata: wayneInvoice('WE-2026-01', '2026-02-15', 'Approved'),
      },
      {
        by: 'admin',
        comment: 'Paid by bank transfer',
        metadata: wayneInvoice('WE-2026-01', '2026-02-15', 'Paid'),
      },
    ],
  },
  {
    name: 'Wayne invoice WE-2026-02',
    tags: ['finance'],
    type: 'Invoice',
    folder: 'Finance/Invoices/2026',
    by: 'member',
    metadata: wayneInvoice('WE-2026-02', '2026-05-15'),
    file: text(
      'wayne-we-2026-02.txt',
      'Wayne Enterprises\nInvoice WE-2026-02\nMaster services agreement, Q2 fee: 62,500.00\n',
    ),
    versions: [
      {
        by: 'member',
        comment: 'Rescanned with the contract reference',
        file: text(
          'wayne-we-2026-02-rescan.txt',
          'Wayne Enterprises\nInvoice WE-2026-02\nRef: Master services agreement\nMaster services agreement, Q2 fee: 62,500.00\n',
        ),
      },
      {
        by: 'admin',
        comment: 'Approved for payment',
        metadata: wayneInvoice('WE-2026-02', '2026-05-15', 'Approved'),
      },
    ],
  },
  {
    name: 'Globex invoice INV-2026-001 (duplicate upload)',
    tags: ['finance'],
    type: 'Invoice',
    folder: 'Finance/Invoices/2026',
    by: 'member',
    metadata: {
      supplier: 'Globex',
      invoiceNumber: 'INV-2026-001',
      amount: 12500,
      dueDate: '2026-10-15',
    },
    file: text(
      'globex-inv-001-copy.txt',
      'Globex Corporation\nInvoice INV-2026-001\nConsulting services: 12,500.00\n',
    ),
    versions: [],
    trashedBy: 'admin',
  },
  {
    name: 'Employment contract — Bob Member',
    tags: ['hr'],
    type: 'Contract',
    folder: 'HR',
    by: 'admin',
    metadata: {
      counterparty: 'Bob Member',
      startDate: '2026-01-05',
      signed: true,
      departments: ['HR'],
      responsible: '@admin',
    },
    file: text('employment-bob.txt', 'EMPLOYMENT CONTRACT\nAcme Corp and Bob Member\n'),
    versions: [
      {
        by: 'admin',
        comment: 'Signed by both parties',
        file: text(
          'employment-bob-signed.txt',
          'EMPLOYMENT CONTRACT\nAcme Corp and Bob Member\nSigned 2026-01-05\n',
        ),
      },
      {
        by: 'admin',
        comment: 'Probation passed',
        metadata: {
          counterparty: 'Bob Member',
          startDate: '2026-01-05',
          signed: true,
          departments: ['HR'],
          notes: 'Probation completed on 2026-07-05.',
          responsible: '@admin',
        },
      },
    ],
  },
  {
    name: 'مؤسسة أحمد للتجارة',
    tags: ['finance'],
    type: 'Invoice',
    folder: 'Finance/Invoices/2026',
    by: 'member',
    metadata: arabicInvoice('AR-2026-014', 4200),
    file: text('ahmad-ar-2026-014.txt', 'مؤسسة أحمد للتجارة\nفاتورة AR-2026-014\nالمبلغ: ٤٢٠٠\n'),
    versions: [
      {
        by: 'admin',
        comment: 'Approved for payment',
        metadata: arabicInvoice('AR-2026-014', 4200, 'Approved'),
      },
      {
        by: 'admin',
        comment: 'Paid by bank transfer',
        metadata: arabicInvoice('AR-2026-014', 4200, 'Paid'),
      },
    ],
  },
  {
    name: 'عقد إيجار المكتب',
    tags: ['legal'],
    type: 'Contract',
    folder: 'Legal/Contracts',
    by: 'admin',
    metadata: {
      counterparty: 'شركة المباني الحديثة',
      value: 36000,
      startDate: '2026-01-01',
      notes: 'عقد إيجار سنوي للمكتب الرئيسي.',
      departments: ['Legal', 'Finance'],
      responsible: '@admin',
    },
    file: text('office-lease-draft.txt', 'عقد إيجار المكتب\nمسودة أولى\n'),
    versions: [
      {
        by: 'admin',
        comment: 'Landlord comments incorporated',
        file: text(
          'office-lease-draft2.txt',
          'عقد إيجار المكتب\nمسودة ثانية\nمدة العقد: سنة واحدة\n',
        ),
      },
      {
        by: 'admin',
        comment: 'Signed by both parties',
        metadata: {
          counterparty: 'شركة المباني الحديثة',
          value: 36000,
          startDate: '2026-01-01',
          signed: true,
          notes: 'عقد إيجار سنوي للمكتب الرئيسي، يتجدد تلقائيا.',
          departments: ['Legal', 'Finance'],
          responsible: '@admin',
        },
      },
    ],
  },
  {
    name: 'مُذَكِّرَة داخليــة',
    tags: [],
    type: 'Memo',
    folder: 'HR',
    by: 'admin',
    metadata: { body: 'اجتماع الموظفين يوم الأحد.', author: 'إدارة الموارد البشرية' },
    versions: [
      {
        by: 'admin',
        comment: 'Time added',
        metadata: {
          body: 'اجتماع الموظفين يوم الأحد الساعة ١٠ صباحا.',
          author: 'إدارة الموارد البشرية',
        },
      },
      {
        by: 'admin',
        comment: 'Room added',
        metadata: {
          body: 'اجتماع الموظفين يوم الأحد الساعة ١٠ صباحا في قاعة الإدارة.',
          author: 'إدارة الموارد البشرية',
        },
      },
    ],
  },
  {
    name: 'فاتورة رقم ١٠٢٤',
    tags: ['finance'],
    type: 'Invoice',
    folder: 'Finance/Invoices/2026',
    by: 'member',
    metadata: schoolInvoice(),
    file: text('invoice-1024.txt', 'مكتبة المدرسة\nفاتورة رقم ١٠٢٤\n'),
    versions: [
      {
        by: 'member',
        comment: 'Rescanned with the stamp',
        file: text('invoice-1024-rescan.txt', 'مكتبة المدرسة\nفاتورة رقم ١٠٢٤\nمختومة\n'),
      },
      { by: 'admin', comment: 'Approved for payment', metadata: schoolInvoice('Approved') },
    ],
  },
];

export const DEMO_MEMBER_GRANTS: Array<
  { folder: string; level: 'view' | 'edit' } | { record: string; level: 'view' | 'edit' }
> = [
  { folder: 'Finance', level: 'edit' },
  { folder: 'Legal', level: 'view' },
  { folder: 'Legal/Contracts', level: 'edit' },
  { record: 'Employment contract — Bob Member', level: 'view' },
];

export interface DemoRelation {
  from: string;
  kind: RelationKind;
  to: string;
}

const WAYNE_MSA = 'Master services agreement — Wayne Enterprises';

export const DEMO_RELATIONS: DemoRelation[] = [
  { from: 'Wayne invoice WE-2026-01', kind: 'partOf', to: WAYNE_MSA },
  { from: 'Wayne invoice WE-2026-02', kind: 'partOf', to: WAYNE_MSA },
  { from: WAYNE_MSA, kind: 'references', to: 'NDA — Stark Industries' },
];
