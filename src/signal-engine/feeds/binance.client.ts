/**
 * BinanceClient — real-time crypto price feed via Binance WebSocket.
 *
 * Subscribes to the combined ticker stream for the assets the Tier-2 signal trades
 * (BTC/ETH/SOL by default). Binance is the *fast* leg: its centralized book updates
 * ahead of the Chainlink oracle, and the divergence is the leading-signal edge.
 *
 * Uses the public combined-stream endpoint; no API key required for market data.
 * Reconnects with backoff on disconnect.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as WebSocket from 'ws';

export interface BinancePrice {
  symbol: string; // e.g. 'BTC'
  price: number;
  timestamp: number; // ms epoch
}

type PriceListener = (price: BinancePrice) => void;

@Injectable()
export class BinanceClient implements OnModuleDestroy {
  private readonly logger = new Logger(BinanceClient.name);
  private readonly wsUrl: string;
  private readonly symbols: string[];
  private ws: WebSocket | null = null;
  private listeners: Set<PriceListener> = new Set();
  private latest = new Map<string, BinancePrice>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(private config: ConfigService) {
    this.wsUrl = this.config.get<string>('BINANCE_WS_URL', 'wss://stream.binance.com:9443/ws');
    const raw = this.config.get<string>('BINANCE_SYMBOLS', 'BTC,ETH,SOL');
    this.symbols = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  }

  /** Open the combined ticker stream and dispatch prices to listeners. */
  connect(): void {
    if (this.ws) return;
    this.destroyed = false;
    this.openSocket();
  }

  /** Subscribe to real-time price updates. Returns an unsubscribe fn. */
  onPrice(listener: PriceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Latest cached price for a symbol (null if not received yet). */
  getPrice(symbol: string): BinancePrice | null {
    return this.latest.get(symbol.toUpperCase()) ?? null;
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
    }
  }

  private openSocket(): void {
    // Binance combined stream: @ticker for each symbol (e.g. btcusdt@ticker).
    const streams = this.symbols.map((s) => `${s.toLowerCase()}usdt@ticker`).join('/');
    const url = `${this.wsUrl}/${streams}`;
    this.logger.log(`Connecting to Binance WS: ${streams}`);
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.logger.log('Binance WS connected');
    });

    this.ws.on('message', (data: Buffer) => {
      try {
        this.handleMessage(JSON.parse(data.toString()));
      } catch (e: any) {
        this.logger.warn(`Binance WS parse error: ${e.message}`);
      }
    });

    this.ws.on('error', (err) => {
      this.logger.error(`Binance WS error: ${err.message}`);
    });

    this.ws.on('close', () => {
      this.logger.warn('Binance WS closed');
      this.scheduleReconnect();
    });
  }

  private handleMessage(msg: any): void {
    // Combined streams wrap payloads in { stream, data }. Raw stream sends data directly.
    const payload = msg?.data ?? msg;
    const rawSymbol: string | undefined = payload?.s; // e.g. 'BTCUSDT'
    const priceStr: string | undefined = payload?.c; // current price
    const eventTs: number = Number(payload?.E ?? Date.now());
    if (!rawSymbol || !priceStr) return;

    const symbol = rawSymbol.replace(/USDT$/i, '').toUpperCase();
    const price = parseFloat(priceStr);
    if (!isFinite(price) || price <= 0) return;

    const bp: BinancePrice = { symbol, price, timestamp: eventTs };
    this.latest.set(symbol, bp);
    for (const listener of this.listeners) {
      try { listener(bp); } catch (e: any) { this.logger.warn(`listener error: ${e.message}`); }
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
    this.logger.warn(`Reconnecting Binance WS in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ws = null;
      this.openSocket();
    }, delay);
  }
}
