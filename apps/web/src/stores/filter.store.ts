import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface FilterState {
  // Task filters
  taskStatus: string[];
  taskPriority: string[];
  taskProjectId: number | null;
  taskAssigneeId: number | null;
  taskSearch: string;

  // Time filters
  timeProjectId: number | null;
  timeWeekStart: string | null;

  // Project filters
  projectStatus: string[];
  projectSearch: string;

  // Contract filters
  contractStatus: string[];
  contractSearch: string;

  // People filters
  peopleTab: 'employees' | 'partners';
  peopleSearch: string;

  // Report filters
  reportDateFrom: string | null;
  reportDateTo: string | null;
  reportProjectId: number | null;
  reportUserId: number | null;

  // Actions
  setTaskFilters: (filters: Partial<Pick<FilterState, 'taskStatus' | 'taskPriority' | 'taskProjectId' | 'taskAssigneeId' | 'taskSearch'>>) => void;
  setTimeFilters: (filters: Partial<Pick<FilterState, 'timeProjectId' | 'timeWeekStart'>>) => void;
  setProjectFilters: (filters: Partial<Pick<FilterState, 'projectStatus' | 'projectSearch'>>) => void;
  setContractFilters: (filters: Partial<Pick<FilterState, 'contractStatus' | 'contractSearch'>>) => void;
  setPeopleFilters: (filters: Partial<Pick<FilterState, 'peopleTab' | 'peopleSearch'>>) => void;
  setReportFilters: (filters: Partial<Pick<FilterState, 'reportDateFrom' | 'reportDateTo' | 'reportProjectId' | 'reportUserId'>>) => void;
  resetFilters: () => void;
}

const initialState = {
  taskStatus: [],
  taskPriority: [],
  taskProjectId: null,
  taskAssigneeId: null,
  taskSearch: '',
  timeProjectId: null,
  timeWeekStart: null,
  projectStatus: [],
  projectSearch: '',
  contractStatus: [],
  contractSearch: '',
  peopleTab: 'employees' as const,
  peopleSearch: '',
  reportDateFrom: null,
  reportDateTo: null,
  reportProjectId: null,
  reportUserId: null,
};

export const useFilterStore = create<FilterState>()(
  persist(
    (set) => ({
      ...initialState,
      setTaskFilters: (filters) => set((s) => ({ ...s, ...filters })),
      setTimeFilters: (filters) => set((s) => ({ ...s, ...filters })),
      setProjectFilters: (filters) => set((s) => ({ ...s, ...filters })),
      setContractFilters: (filters) => set((s) => ({ ...s, ...filters })),
      setPeopleFilters: (filters) => set((s) => ({ ...s, ...filters })),
      setReportFilters: (filters) => set((s) => ({ ...s, ...filters })),
      resetFilters: () => set(initialState),
    }),
    {
      name: 'amec-filters',
    },
  ),
);
