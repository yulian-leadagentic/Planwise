/**
 * Permissions round 4 (2026-11-23) — the project page tells "no access"
 * (403) apart from "not found" (404).
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectUnavailable, PROJECT_NO_ACCESS_MESSAGE } from './project-unavailable';

function axiosError(status: number, data: unknown) {
  return { message: `Request failed with status code ${status}`, response: { status, data } };
}

const render = (error: unknown) => renderToStaticMarkup(createElement(ProjectUnavailable, { error }));

describe('ProjectUnavailable', () => {
  it('a 403 renders the No-access card with the owner-approved text', () => {
    const html = render(
      axiosError(403, {
        success: false,
        error: { code: 'PERMISSION_DENIED', message: "You're not a member of this project.", details: { reason: 'NOT_PROJECT_MEMBER' } },
      }),
    );
    expect(html).toContain('No access');
    expect(html).toContain(PROJECT_NO_ACCESS_MESSAGE);
    expect(PROJECT_NO_ACCESS_MESSAGE).toBe('אין לך גישה לפרויקט הזה, בקש ממנהל הפרויקט להוסיף אותך');
    expect(html).not.toContain('Project not found');
  });

  it('a plain 403 from an older API is still the No-access card', () => {
    expect(render(axiosError(403, { statusCode: 403, message: 'Forbidden resource' }))).toContain(PROJECT_NO_ACCESS_MESSAGE);
  });

  it('a 404 keeps "Project not found"', () => {
    const html = render(axiosError(404, { success: false, error: { code: 'NOT_FOUND', message: 'Project not found' } }));
    expect(html).toContain('Project not found');
    expect(html).not.toContain('No access');
  });

  it('no error (empty payload) is "Project not found"', () => {
    expect(render(null)).toContain('Project not found');
  });
});
