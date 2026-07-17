import { Module } from '@nestjs/common';
import { RiskManager } from './risk-manager.service';

@Module({ providers: [RiskManager], exports: [RiskManager] })
export class RiskModule {}
