import { Injectable, Logger } from '@nestjs/common';
import { INotificationChannel, NotificationPayload } from './notification-channel.interface';

/**
 * Slack adapter — Phase 3 stub with structure ready for implementation.
 * To activate: configure SLACK_WEBHOOK_URL in .env and implement send().
 */
@Injectable()
export class SlackAdapter implements INotificationChannel {
  readonly channelName = 'slack';
  private readonly logger = new Logger(SlackAdapter.name);

  async send(notification: NotificationPayload): Promise<void> {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) {
      this.logger.debug('Slack webhook not configured, skipping');
      return;
    }

    // Slack Block Kit payload
    const payload = {
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${notification.title}*${notification.body ? `\n${notification.body}` : ''}`,
          },
        },
        ...(notification.actorName
          ? [{
              type: 'context',
              elements: [{ type: 'mrkdwn', text: `By: ${notification.actorName}` }],
            }]
          : []),
        ...(notification.deepLink
          ? [{
              type: 'actions',
              elements: [{
                type: 'button',
                text: { type: 'plain_text', text: 'Open in Planwise' },
                url: notification.deepLink,
                style: 'primary',
              }],
            }]
          : []),
      ],
    };

    try {
      // TODO: Uncomment when Slack webhook is configured
      // const response = await fetch(webhookUrl, {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify(payload),
      // });
      // if (!response.ok) throw new Error(`Slack webhook returned ${response.status}`);
      this.logger.log(`[DRY RUN] Would send to Slack: ${notification.title}`);
    } catch (error) {
      this.logger.error(`Failed to send Slack notification: ${error}`);
    }
  }

  async isEnabled(userId: number): Promise<boolean> {
    return !!process.env.SLACK_WEBHOOK_URL;
  }
}
