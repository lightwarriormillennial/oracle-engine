/**
 * AppModule — root NestJS module.
 */
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PolymarketModule } from './polymarket/polymarket.module';
import { MarketMakerModule } from './market-maker/market-maker.module';
import { SignalEngineModule } from './signal-engine/signal-engine.module';
import { RiskModule } from './risk/risk.module';
import { ExecutionModule } from './execution/execution.module';
import { StateModule } from './state/state.module';
import { AlertsModule } from './alerts/alerts.module';
import { EngineService } from './engine.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '.env.example'] }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'sqlite',
        database: (config.get('DATABASE_URL', 'sqlite:./state/oracle.db')).replace('sqlite:', ''),
        autoLoadEntities: true,
        synchronize: config.get('NODE_ENV') !== 'production',
      }),
    }),
    PolymarketModule, MarketMakerModule, SignalEngineModule,
    RiskModule, ExecutionModule, StateModule, AlertsModule,
  ],
  providers: [EngineService],
})
export class AppModule {}
