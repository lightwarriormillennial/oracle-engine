import { Module } from '@nestjs/common';
import { RewardFarmingStrategy } from './strategies/reward-farming.strategy';
import { AvellanedaStoikovStrategy } from './strategies/avellaneda-stoikov.strategy';
import { STRATEGIES } from '../common/interfaces';

@Module({
  providers: [
    RewardFarmingStrategy,
    AvellanedaStoikovStrategy,
    {
      // Multi-provider token: injectable array of all Tier-1 strategies.
      provide: STRATEGIES,
      useFactory: (rf: RewardFarmingStrategy, as: AvellanedaStoikovStrategy) => [rf, as],
      inject: [RewardFarmingStrategy, AvellanedaStoikovStrategy],
    },
  ],
  exports: [RewardFarmingStrategy, AvellanedaStoikovStrategy, STRATEGIES],
})
export class MarketMakerModule {}
