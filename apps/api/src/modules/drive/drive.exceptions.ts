import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Thrown when an operation needs a Google Drive config but none is
 * present (or `enabled` is false). Distinct exception type so the
 * frontend can react with a specific message: "Google Drive is not
 * configured. Ask your admin to set it up in Admin → Integrations."
 *
 * Uses 503 SERVICE_UNAVAILABLE rather than 404 — the requested project
 * / task / deliverable does exist; the Drive dependency the operation
 * needs is what's missing.
 */
export class DriveNotConfiguredException extends HttpException {
  constructor(message = 'Google Drive integration is not configured or is disabled.') {
    super({ statusCode: HttpStatus.SERVICE_UNAVAILABLE, message, error: 'DriveNotConfigured' }, HttpStatus.SERVICE_UNAVAILABLE);
  }
}

/**
 * Thrown when the SA can see the Shared Drive but not the file the
 * user is trying to attach. Bubbles up as 403 with the message shown
 * to the admin — usually "the file isn't in the configured Shared
 * Drive". Distinct from a generic Google 403 so the controller can
 * craft a helpful error.
 */
export class DriveFileNotAccessibleException extends HttpException {
  constructor(fileId: string, originalMessage?: string) {
    super(
      {
        statusCode: HttpStatus.FORBIDDEN,
        message:
          `The service account can't access file "${fileId}". Ensure it lives inside the configured Shared Drive.` +
          (originalMessage ? ` (Google says: ${originalMessage})` : ''),
        error: 'DriveFileNotAccessible',
      },
      HttpStatus.FORBIDDEN,
    );
  }
}
