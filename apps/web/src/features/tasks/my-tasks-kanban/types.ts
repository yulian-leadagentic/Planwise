export type TabMode = 'time' | 'kanban' | 'upcoming';

export type SortField = 'task' | 'project' | 'status' | 'due';
export type SortDir = 'asc' | 'desc';

/**
 * Upcoming-view buckets — derived from each task's endDate vs. today.
 * Order matters: the UI renders sections in this order, so the most
 * urgent rolls to the top.
 */
export type DueBucket = 'overdue' | 'today' | 'this_week' | 'next_week' | 'later' | 'no_date';
