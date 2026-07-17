/**
 * ClobClient — Polymarket CLOB REST + WebSocket client.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';

export interface ClobOrder {
  tokenID: string; price: number; size: number; side: 'BUY' | 'SELL';
  feeRateBps?: number; nonce?: number; tickSize?: string; negRisk?: boolean;
}

@Injectable()
export class ClobClient {
  private readonly logger = new Logger(ClobClient.name);
  private readonly host: string;
  private readonly wsHost: string;

  constructor(private config: ConfigService) {
    this.host = this.config.get<string>('POLY_CLOB_HOST', 'https://clob.polymarket.com');
    this.wsHost = this.config.get<string>('POLY_WS_HOST', 'wss://ws-subscriptions-clob.polymarket.com/ws');
  }

  async postOrder(order: ClobOrder): Promise<{ orderId: string; status: string }> {
    // Production: sign with EIP-712 via @polymarket/clob-client
    this.logger.debug(`[STUB] postOrder: ${order.side} ${order.size}@${order.price} token=${order.tokenID}`);
    return { orderId: `stub-${Date.now()}`, status: 'matched' };
  }

  async cancelOrder(orderId: string): Promise<void> {
    this.logger.debug(`[STUB] cancelOrder: ${orderId}`);
  }

  async cancelAll(): Promise<void> {
    this.logger.log('cancelAll requested');
  }

  async getOrderBook(tokenId: string): Promise<any> {
    const resp = await fetch(`${this.host}/book?token_id=${tokenId}`);
    return resp.json();
  }

  subscribeOrderBook(tokenId: string, onMessage: (data: any) => void, onOpen?: () => void): WebSocket {
    const ws = new WebSocket(this.wsHost);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'Subscribe', channels: ['market', 'user'], assets_ids: [tokenId] }));
      onOpen?.();
    });
    ws.on('message', (data: Buffer) => {
      try { onMessage(JSON.parse(data.toString())); } catch (e) { this.logger.warn(`WS parse error: ${e}`); }
    });
    ws.on('error', (err) => this.logger.error(`WS error: ${err.message}`));
    ws.on('close', () => this.logger.warn(`WS closed for ${tokenId}`));
    return ws;
  }
}
