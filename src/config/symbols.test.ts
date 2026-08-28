import { describe, expect, it } from 'vitest';
import { SYMBOLS, findSymbol, DEFAULT_SYMBOL_ID } from './symbols';

describe('SYMBOLS config', () => {
  it('contains the original four pairs', () => {
    const ids = SYMBOLS.map((s) => s.id);
    expect(ids).toContain('BTCUSD');
    expect(ids).toContain('XAUUSD');
    expect(ids).toContain('ETHUSDT');
    expect(ids).toContain('ETHBTC');
  });

  it('contains the four newly added pairs', () => {
    const ids = SYMBOLS.map((s) => s.id);
    expect(ids).toContain('SOLUSDT');
    expect(ids).toContain('SUIUSDT');
    expect(ids).toContain('AVAXUSDT');
    expect(ids).toContain('BNBUSDT');
  });

  it('has a Binance spot provider id for every crypto pair', () => {
    for (const s of SYMBOLS) {
      if (s.category === 'crypto') {
        expect(s.providerIds.binance, `${s.id} missing binance id`).toBeTruthy();
      }
    }
  });

  it('has a Binance futures provider id for every crypto pair that lists USDT', () => {
    for (const s of SYMBOLS) {
      if (s.category === 'crypto' && s.quote === 'USDT') {
        expect(s.providerIds.binanceFutures, `${s.id} missing binanceFutures id`).toBeTruthy();
      }
    }
  });

  it('has a CoinGecko id for every crypto pair except ETHBTC', () => {
    for (const s of SYMBOLS) {
      if (s.category === 'crypto' && s.id !== 'ETHBTC') {
        expect(s.providerIds.coingecko, `${s.id} missing coingecko id`).toBeTruthy();
      }
    }
  });

  it('assigns a sensible price precision to each new pair', () => {
    const sol = findSymbol('SOLUSDT');
    const sui = findSymbol('SUIUSDT');
    const avax = findSymbol('AVAXUSDT');
    const bnb = findSymbol('BNBUSDT');
    expect(sol?.pricePrecision).toBe(2);
    expect(sui?.pricePrecision).toBe(4);
    expect(avax?.pricePrecision).toBe(3);
    expect(bnb?.pricePrecision).toBe(2);
  });

  it('findSymbol resolves each new pair by id', () => {
    expect(findSymbol('SOLUSDT')?.display).toBe('SOL/USDT');
    expect(findSymbol('SUIUSDT')?.display).toBe('SUI/USDT');
    expect(findSymbol('AVAXUSDT')?.display).toBe('AVAX/USDT');
    expect(findSymbol('BNBUSDT')?.display).toBe('BNB/USDT');
  });

  it('findSymbol returns undefined for unknown ids', () => {
    expect(findSymbol('DOGEUSDT')).toBeUndefined();
    expect(findSymbol('')).toBeUndefined();
  });

  it('keeps a single canonical default symbol', () => {
    expect(DEFAULT_SYMBOL_ID).toBe('BTCUSD');
    expect(findSymbol(DEFAULT_SYMBOL_ID)).toBeDefined();
  });

  it('XAUUSD is the only metal (no futures)', () => {
    const metals = SYMBOLS.filter((s) => s.category === 'metal');
    expect(metals.map((m) => m.id)).toEqual(['XAUUSD']);
    expect(findSymbol('XAUUSD')?.providerIds.binanceFutures).toBeUndefined();
  });

  it('uses uppercase ticker on Binance provider ids', () => {
    for (const s of SYMBOLS) {
      if (s.providerIds.binance) {
        expect(s.providerIds.binance).toBe(s.providerIds.binance.toUpperCase());
      }
      if (s.providerIds.binanceFutures) {
        expect(s.providerIds.binanceFutures).toBe(s.providerIds.binanceFutures.toUpperCase());
      }
    }
  });
});
