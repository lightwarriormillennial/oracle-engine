import { Module } from '@nestjs/common';
import { LeadingSignalStrategy } from './signals/leading-signal.strategy';
import { BinanceClient } from './feeds/binance.client';
import { ChainlinkClient } from './feeds/chainlink.client';
import { PriceFeedAggregator } from './feeds/price-feed-aggregator';
import { BacktestService } from './backtest.service';

@Module({
  providers: [LeadingSignalStrategy, BinanceClient, ChainlinkClient, PriceFeedAggregator, BacktestService],
  exports: [LeadingSignalStrategy, PriceFeedAggregator, BacktestService],
})
export class SignalEngineModule {}
