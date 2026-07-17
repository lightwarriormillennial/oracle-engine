/**
 * ClobClient — Polymarket CLOB REST + WebSocket client with EIP-712 order signing.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';
import { ethers } from 'ethers';
import {
  ClobClient as PolyClobClient,
  type ApiKeyCreds,
  type OrderBookSummary,
  type UserOrder,
  Side as OrderSide,
  OrderType,
} from '@polymarket/clob-client';

export interface ClobOrder {
  tokenID: string; price: number; size: number; side: 'BUY' | 'SELL';
  feeRateBps?: number; nonce?: number; tickSize?: string; negRisk?: boolean;
}

@Injectable()
export class ClobClient implements OnModuleInit {
  private readonly logger = new Logger(ClobClient.name);
  private readonly host: string;
  private readonly wsHost: string;
  private readonly chainId: number;
  private readonly privateKey?: string;
  private readonly proxyAddress?: string;
  private readonly signatureType: number;
  private polyClient: PolyClobClient | null = null;
  private creds: ApiKeyCreds | null = null;

  constructor(private config: ConfigService) {
    this.host = this.config.get<string>('POLY_CLOB_HOST', 'https://clob.polymarket.com');
    this.wsHost = this.config.get<string>('POLY_WS_HOST', 'wss://ws-subscriptions-clob.polymarket.com/ws');
    this.chainId = this.config.get<number>('POLY_CHAIN_ID', 137);
    this.privateKey = this.config.get<string>('POLY_PRIVATE_KEY');
    this.proxyAddress = this.config.get<string>('POLY_PROXY_ADDRESS');
    this.signatureType = this.config.get<number>('POLY_SIGNATURE_TYPE', 0);
  }

  async onModuleInit(): Promise<void> {
    if (!this.privateKey || !this.proxyAddress) {
      this.logger.warn('POLY_PRIVATE_KEY or POLY_PROXY_ADDRESS not set — order signing disabled (paper mode only)');
      return;
    }
    try {
      const wallet = new ethers.Wallet(this.privateKey);
      // Cast: ethers v6 Wallet has _signTypedData + getAddress, matching EthersSigner interface
      this.polyClient = new PolyClobClient(
        this.host,
        this.chainId,
        wallet as any,
        undefined,
        this.signatureType,
        this.proxyAddress,
      );
      this.creds = await this.polyClient.createOrDeriveApiKey();
      // Re-initialize with derived credentials
      this.polyClient = new PolyClobClient(
        this.host,
        this.chainId,
        wallet as any,
        this.creds,
        this.signatureType,
        this.proxyAddress,
      );
      this.logger.log('Polymarket CLOB client initialized with EIP-712 signing');
    } catch (e: any) {
      this.logger.error(`Failed to initialize CLOB client: ${e.message}`);
    }
  }

  async postOrder(order: ClobOrder): Promise<{ orderId: string; status: string }> {
    if (!this.polyClient || !this.creds) {
      this.logger.warn('Order signing not initialized — call requires POLY_PRIVATE_KEY + POLY_PROXY_ADDRESS');
      return { orderId: `unsigned-${Date.now()}`, status: 'rejected' };
    }
    try {
      const userOrder: UserOrder = {
        tokenID: order.tokenID,
        price: order.price,
        size: order.size,
        side: order.side === 'BUY' ? OrderSide.BUY : OrderSide.SELL,
        feeRateBps: order.feeRateBps,
        nonce: order.nonce,
      };
      const signedOrder = await this.polyClient.createOrder(userOrder);
      const result = await this.polyClient.postOrder(signedOrder, OrderType.GTC, false, true);
      this.logger.debug(`Order posted: ${JSON.stringify(result)}`);
      return {
        orderId: result.orderID ?? result.orderId ?? `order-${Date.now()}`,
        status: result.status ?? 'submitted',
      };
    } catch (e: any) {
      this.logger.error(`postOrder failed: ${e.message}`);
      throw e;
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (!this.polyClient) {
      this.logger.debug(`[no-signing] cancelOrder: ${orderId}`);
      return;
    }
    try {
      await this.polyClient.cancelOrder({ orderID: orderId });
    } catch (e: any) {
      this.logger.warn(`cancelOrder failed: ${e.message}`);
    }
  }

  async cancelAll(): Promise<void> {
    if (!this.polyClient) {
      this.logger.log('[no-signing] cancelAll requested');
      return;
    }
    try {
      await this.polyClient.cancelAll();
      this.logger.log('All orders cancelled');
    } catch (e: any) {
      this.logger.warn(`cancelAll failed: ${e.message}`);
    }
  }

  async getOrderBook(tokenId: string): Promise<OrderBookSummary> {
    if (this.polyClient) {
      return this.polyClient.getOrderBook(tokenId);
    }
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
