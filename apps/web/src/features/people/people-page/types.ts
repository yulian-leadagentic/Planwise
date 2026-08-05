export interface SeniorityHistoryRow {
  id: number;
  seniorityLevelId: number;
  startDate: string;
  endDate: string | null;
  notes: string | null;
  seniorityLevel: {
    id: number;
    code: string;
    name: string;
    defaultHourlyCost: string | null;
    currency: string | null;
  };
}
