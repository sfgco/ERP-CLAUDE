/** Document number prefixes: `PREFIX-YYYY-#####` from an atomic counter (CLAUDE.md "Numbering"). */
export const NUMBER_PREFIXES = {
  ticket: 'TKT',
  hrRequest: 'HRQ',
  employee: 'EMP',
  task: 'TSK',
  event: 'EVT',
  employeeReport: 'RPT',
  news: 'NWS',
  document: 'DOC',
  purchaseRequest: 'PRQ',
  financialRequest: 'FRQ',
  export: 'EXP',
  contract: 'CNT',
  profileChange: 'PCR',
  certificate: 'CRT',
  // CRM / Sales [SAL §19 «رقم مرجعي تلقائي»]
  customer: 'CUS',
  lead: 'LED',
  opportunity: 'OPP',
  containerSale: 'CSR',
  sortingContract: 'SRT',
  cleaningContract: 'CLN',
  destruction: 'DST',
  containerRental: 'RNT',
  scrap: 'SCR',
  assetReturn: 'ARO',
  quote: 'QUO',
  salesOrder: 'SO',
  invoice: 'INV',
  discussion: 'DSC',
  // HR H3a [HR §3.6, §3.7, §3.8]
  payrollRun: 'PAY',
  disciplinary: 'DIS',
  training: 'TRN',
  // HR H3b [HR §3.2, §3.10]
  requisition: 'REQ',
  offer: 'OFR',
  offboarding: 'EOS',
} as const;
export type NumberPrefixKey = keyof typeof NUMBER_PREFIXES;
export const NUMBER_PATTERN = /^[A-Z]{2,5}-\d{4}-\d{5,}$/;
