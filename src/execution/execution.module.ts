import { Module } from '@nestjs/common';
import { ExecutionGateway } from './execution-gateway.service';
import { PolymarketModule } from '../polymarket/polymarket.module';
import { RiskModule } from '../risk/risk.module';

@Module({ imports: [PolymarketModule, RiskModule], providers: [ExecutionGateway], exports: [ExecutionGateway] })
export class ExecutionModule {}
