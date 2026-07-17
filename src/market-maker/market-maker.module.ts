import { Module } from '@nestjs/common';
import { RewardFarmingStrategy } from './strategies/reward-farming.strategy';
import { AvellanedaStoikovStrategy } from './strategies/avellaneda-stoikov.strategy';

@Module({ providers: [RewardFarmingStrategy, AvellanedaStoikovStrategy], exports: [RewardFarmingStrategy, AvellanedaStoikovStrategy] })
export class MarketMakerModule {}
