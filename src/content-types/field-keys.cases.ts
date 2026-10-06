export interface FieldKeyCase {
  label: string;
  taken: string[];
  expected: string;
}

const SIXTY = 'Supplier reference number for the quarterly procurement plan';

export const FIELD_KEY_CASES: readonly FieldKeyCase[] = [
  { label: 'Invoice date', taken: [], expected: 'invoiceDate' },
  { label: 'Invoice date', taken: ['invoiceDate'], expected: 'invoiceDate2' },
  { label: 'Invoice date', taken: ['invoiceDate', 'invoiceDate2'], expected: 'invoiceDate3' },
  { label: 'تاريخ', taken: [], expected: 'field1' },
  { label: 'تاريخ', taken: ['field1'], expected: 'field2' },
  { label: 'تاريخ', taken: ['field2'], expected: 'field1' },
  { label: '', taken: [], expected: 'field1' },
  { label: '   ', taken: [], expected: 'field1' },
  { label: 'Field', taken: [], expected: 'field1' },
  { label: '2024 Budget', taken: [], expected: 'budget' },
  { label: '2024', taken: [], expected: 'field1' },
  { label: 'Café Owner', taken: [], expected: 'cafeOwner' },
  { label: 'HTML page', taken: [], expected: 'htmlPage' },
  { label: '  due   DATE ', taken: [], expected: 'dueDate' },
  { label: 'E-mail', taken: [], expected: 'email' },
  { label: 'Due/paid date', taken: [], expected: 'duepaidDate' },
  { label: 'Line 2 total', taken: [], expected: 'line2Total' },
  { label: 'Invoice\tdate', taken: [], expected: 'invoiceDate' },
  { label: 'Invoice\ndate', taken: [], expected: 'invoiceDate' },
  { label: 'Constructor', taken: [], expected: 'constructor2' },
  { label: 'Value of', taken: [], expected: 'valueOf2' },
  { label: 'Status', taken: ['invoiceDate'], expected: 'status' },
  { label: 'Status', taken: ['status'], expected: 'status2' },
  { label: SIXTY, taken: [], expected: 'supplierReferenceNumberForTheQuarterlyPr' },
  {
    label: SIXTY,
    taken: ['supplierReferenceNumberForTheQuarterlyPr'],
    expected: 'supplierReferenceNumberForTheQuarterlyP2',
  },
];
