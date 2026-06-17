import { useState } from 'react';

/**
 * Per-project + per-user favorite-file set, persisted to localStorage.
 *
 * Shared between the project Files tab and the task drawer's Project Files
 * panel so a star pinned in one place shows up in the other immediately.
 * Server-side persistence is a follow-up; localStorage is intentional for
 * now (no schema migration needed).
 *
 * File IDs are the composite strings the /projects/:id/files endpoint
 * returns (e.g. "project:123" or "task:456") — both panels read from the
 * same source, so the IDs match.
 */
export function useProjectFileFavorites(projectId: number) {
  const storageKey = `planwise:project-${projectId}:favorite-files`;
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []);
    } catch {
      return new Set();
    }
  });
  const toggleFavorite = (fileId: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      try {
        localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        // localStorage full / disabled — fail silently, in-memory state still works
      }
      return next;
    });
  };
  return { favorites, toggleFavorite };
}
