import { Module } from '@nestjs/common';
import { ClobClient } from './clients/clob.client';
import { GammaClient } from './clients/gamma.client';

@Module({ providers: [ClobClient, GammaClient], exports: [ClobClient, GammaClient] })
export class PolymarketModule {}
