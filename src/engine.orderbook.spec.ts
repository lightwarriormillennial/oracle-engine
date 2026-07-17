/**
 * OrderBook reconstruction tests.
 *
 * Exercises the OrderBook interface helpers (bestBid, bestAsk, midPrice,
 * microprice, spread, depthAtLevel) that engine.service.ts builds from WS deltas.
 * These are the exact closures used in the live trading loop — see
 * engine.service.ts:151-181 (buildOrderBook).
 */
import { makeBook } from './common/test-helpers';

describe('OrderBook helpers', () => {
  describe('bestBid / bestAsk', () => {
    it('returns the highest bid and lowest ask', () => {
      const book = makeBook(
        [[0.48, 50], [0.49, 100], [0.47, 200]],
        [[0.51, 100], [0.52, 50]],
      );
      expect(book.bestBid()).toEqual({ price: 0.49, size: 100 });
      expect(book.bestAsk()).toEqual({ price: 0.51, size: 100 });
    });

    it('returns null for an empty side', () => {
      const book = makeBook([], [[0.51, 100]]);
      expect(book.bestBid()).toBeNull();
      expect(book.bestAsk()).toEqual({ price: 0.51, size: 100 });
    });
  });

  describe('midPrice', () => {
    it('computes the midpoint between best bid and ask', () => {
      const book = makeBook([[0.48, 100]], [[0.52, 100]]);
      expect(book.midPrice()).toBeCloseTo(0.5, 10);
    });

    it('returns 0.5 when the book is empty on one side', () => {
      const book = makeBook([], [[0.51, 100]]);
      expect(book.midPrice()).toBe(0.5);
    });

    it('returns 0.5 when the book is fully empty', () => {
      const book = makeBook([], []);
      expect(book.midPrice()).toBe(0.5);
    });
  });

  describe('spread', () => {
    it('computes ask minus bid', () => {
      const book = makeBook([[0.48, 100]], [[0.52, 100]]);
      expect(book.spread()).toBeCloseTo(0.04, 10);
    });

    it('returns 1 when one side is empty (degenerate spread)', () => {
      const book = makeBook([], [[0.51, 100]]);
      expect(book.spread()).toBe(1);
    });
  });

  describe('microprice', () => {
    it('weights toward the opposite side with more depth (buying pressure pulls up)', () => {
      // Bid side has 10x the depth of ask side → heavy bid volume gives more weight
      // to the ask price, pulling microprice above mid.
      // microprice = (bestBid * askVol + bestAsk * bidVol) / total
      //            = (0.48*100 + 0.52*1000) / 1100 ≈ 0.5164
      const book = makeBook([[0.48, 1000]], [[0.52, 100]]);
      const mp = book.microprice();
      expect(mp).toBeGreaterThan(0.5);
      expect(mp).toBeLessThan(0.52);
    });

    it('returns best bid when ask side is empty', () => {
      const book = makeBook([[0.48, 100]], []);
      expect(book.microprice()).toBe(0.48);
    });

    it('returns 0.5 when both sides are empty', () => {
      const book = makeBook([], []);
      expect(book.microprice()).toBe(0.5);
    });
  });

  describe('depthAtLevel', () => {
    it('sums the top N levels on the bid side', () => {
      const book = makeBook([[0.49, 100], [0.48, 200], [0.47, 300]], []);
      expect(book.depthAtLevel('bid', 2)).toBe(300); // 100 + 200
    });

    it('sums the top N levels on the ask side', () => {
      const book = makeBook([], [[0.51, 50], [0.52, 150], [0.53, 250]]);
      expect(book.depthAtLevel('ask', 2)).toBe(200); // 50 + 150
    });

    it('handles requesting more levels than available', () => {
      const book = makeBook([[0.49, 100]], [[0.51, 50]]);
      expect(book.depthAtLevel('bid', 5)).toBe(100);
      expect(book.depthAtLevel('ask', 5)).toBe(50);
    });
  });
});

describe('OrderBook reconstruction from WS price_change events', () => {
  // This mirrors the updateBookState logic in engine.service.ts:126-149.
  // We simulate the WS delta application that builds the book state.

  it('applies price_change deltas to build a sorted book', () => {
    // Simulate: BUY side gets two levels, ASK side gets one
    const bids = new Map<number, number>();
    const asks = new Map<number, number>();
    const events = [{
      changes: [
        { price: '0.49', side: 'BUY', size: '100' },
        { price: '0.48', side: 'BUY', size: '200' },
        { price: '0.51', side: 'SELL', size: '150' },
      ],
    }];
    for (const evt of events) {
      for (const ch of evt.changes) {
        const price = parseFloat(ch.price);
        const size = parseFloat(ch.size);
        const book = ch.side === 'BUY' ? bids : asks;
        if (size === 0) book.delete(price);
        else book.set(price, size);
      }
    }
    const book = makeBook(
      [...bids.entries()] as Array<[number, number]>,
      [...asks.entries()] as Array<[number, number]>,
    );
    expect(book.bestBid()).toEqual({ price: 0.49, size: 100 });
    expect(book.bestAsk()).toEqual({ price: 0.51, size: 150 });
    expect(book.midPrice()).toBeCloseTo(0.5, 10);
  });

  it('removes a level when a price_change sets size to 0', () => {
    const bids = new Map<number, number>([[0.49, 100], [0.48, 200]]);
    // Remove the 0.49 level
    const events = [{ changes: [{ price: '0.49', side: 'BUY', size: '0' }] }];
    for (const evt of events) {
      for (const ch of evt.changes) {
        const price = parseFloat(ch.price);
        const size = parseFloat(ch.size);
        const book = ch.side === 'BUY' ? bids : new Map<number, number>();
        if (size === 0) book.delete(price);
        else book.set(price, size);
      }
    }
    const book = makeBook([...bids.entries()] as Array<[number, number]>, []);
    expect(book.bestBid()).toEqual({ price: 0.48, size: 200 });
    expect(book.bids).toHaveLength(1);
  });

  it('handles BID/ASK side aliases (Polymarket sends BUY/SELL)', () => {
    const bids = new Map<number, number>();
    const asks = new Map<number, number>();
    const events = [{
      changes: [
        { price: '0.49', side: 'BID', size: '100' },
        { price: '0.51', side: 'ASK', size: '150' },
      ],
    }];
    for (const evt of events) {
      for (const ch of evt.changes) {
        const price = parseFloat(ch.price);
        const size = parseFloat(ch.size);
        // engine.service.ts maps BUY or BID → bids; else → asks
        const book = ch.side === 'BUY' || ch.side === 'BID' ? bids : asks;
        book.set(price, size);
      }
    }
    expect(bids.get(0.49)).toBe(100);
    expect(asks.get(0.51)).toBe(150);
  });
});
