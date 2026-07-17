import { Module } from '@nestjs/common';
import { ExecutionGateway } from './execution-gateway.service';
import { PnlReconciler } from './pnl-reconciler.service';
import { PolymarketModule } from '../polymarket/polymarket.module';
import { RiskModule } from '../risk/risk.module';
import { AlertsModule } from '../alerts/alerts.module';

@Module({
  imports: [PolymarketModule, RiskModule, AlertsModule],
  providers: [ExecutionGateway, PnlReconciler],
  exports: [ExecutionGateway, PnlReconciler],
})
export class ExecutionModule {}
