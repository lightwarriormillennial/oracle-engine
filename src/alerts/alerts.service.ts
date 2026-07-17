/**
 * AlertsService — Telegram notifications for fills, halts, and anomalies.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly botToken?: string;
  private readonly chatId?: string;

  constructor(private config: ConfigService) {
    this.botToken = this.config.get<string>('TELEGRAM_ALERT_BOT_TOKEN');
    this.chatId = this.config.get<string>('TELEGRAM_ALERT_CHAT_ID');
  }

  async send(message: string, priority: 'info' | 'warn' | 'critical' = 'info'): Promise<void> {
    const prefix = priority === 'critical' ? '🚨' : priority === 'warn' ? '⚠️' : 'ℹ️';
    const text = `${prefix} Oracle Engine: ${message}`;
    this.logger.log(text);
    if (this.botToken && this.chatId) {
      try {
        await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'Markdown' }),
        });
      } catch (e) { this.logger.warn(`Telegram alert failed: ${e}`); }
    }
  }
}
