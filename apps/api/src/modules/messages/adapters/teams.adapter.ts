import { Injectable, Logger } from '@nestjs/common';
import { INotificationChannel, NotificationPayload } from './notification-channel.interface';

/**
 * Microsoft Teams adapter — Phase 3 stub with structure ready for implementation.
 * To activate: configure TEAMS_WEBHOOK_URL in .env and implement send().
 */
@Injectable()
export class TeamsAdapter implements INotificationChannel {
  readonly channelName = 'teams';
  private readonly logger = new Logger(TeamsAdapter.name);

  async send(notification: NotificationPayload): Promise<void> {
    const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
    if (!webhookUrl) {
      this.logger.debug('Teams webhook not configured, skipping');
      return;
    }

    // Teams Adaptive Card payload structure
    const card = {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          contentUrl: null,
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
              {
                type: 'TextBlock',
                size: 'Medium',
                weight: 'Bolder',
                text: notification.title,
              },
              ...(notification.body
                ? [{ type: 'TextBlock', text: notification.body, wrap: true }]
                : []),
              ...(notification.actorName
                ? [{ type: 'TextBlock', text: `By: ${notification.actorName}`, isSubtle: true, size: 'Small' }]
                : []),
            ],
            actions: notification.deepLink
              ? [{ type: 'Action.OpenUrl', title: 'Open in Planwise', url: notification.deepLink }]
              : [],
          },
        },
      ],
    };

    try {
      // TODO: Uncomment when Teams webhook is configured
      // const response = await fetch(webhookUrl, {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify(card),
      // });
      // if (!response.ok) throw new Error(`Teams webhook returned ${response.status}`);
      this.logger.log(`[DRY RUN] Would send to Teams: ${notification.title}`);
    } catch (error) {
      this.logger.error(`Failed to send Teams notification: ${error}`);
    }
  }

  async isEnabled(userId: number): Promise<boolean> {
    return !!process.env.TEAMS_WEBHOOK_URL;
  }
}
