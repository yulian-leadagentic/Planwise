/**
 * Interface for notification delivery channels.
 * Implemented by InApp, Email, Teams, Slack adapters.
 */
export interface INotificationChannel {
  readonly channelName: string;
  send(notification: NotificationPayload): Promise<void>;
  isEnabled(userId: number): Promise<boolean>;
}

export interface NotificationPayload {
  userId: number;
  type: string;
  title: string;
  body?: string;
  entityType?: string;
  entityId?: number;
  deepLink?: string;
  actorName?: string;
}
