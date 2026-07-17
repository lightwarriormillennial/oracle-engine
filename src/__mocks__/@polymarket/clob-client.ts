/**
 * Jest manual mock for @polymarket/clob-client.
 *
 * The real package ships as ESM ("type": "module" in its package.json), which
 * Jest's CommonJS runtime cannot load. This stub provides the types/enums/classes
 * that our code imports, so transitive imports through clob.client.ts don't crash
 * the test runner.
 *
 * Tests that need to exercise CLOB behaviour inject their own stubs via constructor
 * DI — they never touch this mock's method bodies.
 */

export enum Side {
  BUY = 'BUY',
  SELL = 'SELL',
}

export enum OrderType {
  GTC = 'GTC',
  FOK = 'FOK',
  GTD = 'GTD',
}

export interface ApiKeyCreds {
  key: string;
  secret: string;
  passphrase: string;
}

export interface OrderBookSummary {
  market: string;
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  hash: string;
  timestamp: string;
}

export interface UserOrder {
  tokenID: string;
  price: number;
  size: number;
  side: Side;
  feeRateBps?: number;
  nonce?: number;
}

export class ClobClient {
  constructor(
    _host: string,
    _chainId: number,
    _signer?: any,
    _creds?: ApiKeyCreds,
    _signatureType?: number,
    _funderAddress?: string,
  ) {}

  async createOrDeriveApiKey(): Promise<ApiKeyCreds> {
    return { key: 'mock-key', secret: 'mock-secret', passphrase: 'mock-pass' };
  }

  async createOrder(_order: UserOrder): Promise<any> {
    return { orderID: 'mock-order-id' };
  }

  async postOrder(_order: any, _orderType?: OrderType, _options?: any): Promise<any> {
    return { orderID: 'mock-order-id', status: 'matched' };
  }

  async cancelOrder(_order: { orderID: string }): Promise<any> {
    return {};
  }

  async cancelAll(): Promise<any> {
    return {};
  }

  async getOrderBook(_tokenId: string): Promise<OrderBookSummary> {
    return {
      market: 'mock',
      asset_id: 'mock',
      bids: [{ price: '0.5', size: '100' }],
      asks: [{ price: '0.51', size: '100' }],
      hash: 'mock',
      timestamp: String(Date.now()),
    };
  }
}
