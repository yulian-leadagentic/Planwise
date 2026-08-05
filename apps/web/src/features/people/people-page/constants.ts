// `businessPartnerId === ''` means "create a fresh BP" (default); a number
// means link this login to that existing person BP and skip BP creation.
export const emptyPerson = {
  // M1.1 — business code. For auto-mode ranges the server allocates;
  // leave blank. For manual/external, the admin enters here.
  code: '',
  email: '',
  password: '',
  firstName: '',
  lastName: '',
  firstNameHe: '',
  lastNameHe: '',
  phone: '',
  roleId: '',
  userType: 'employee' as string,
  position: '',
  department: '',
  companyName: '',
  // M4a.4 — employment fields. End date defaults to the
  // OPEN_ENDED_SENTINEL (9999-12-31) — same convention used for
  // seniority history rows — so a "currently employed" employee
  // appears with an explicit far-future end date instead of an empty
  // field that reads as "no end planned".
  employmentDate: '',
  employmentEndDate: '9999-12-31',
  dailyStandardHours: '',
  // M5a — seniority drives default hourly cost (via SeniorityLevel catalog).
  seniorityLevelId: '' as number | '',
  businessPartnerId: '' as number | '',
  // External Employees only — id of the organization (customer / supplier
  // / etc.) this person works at. Server-side this triggers an
  // employee_of relationship between the new person BP and the org.
  employerOrgId: '' as number | '',
};

export const inputClass = 'w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none';
