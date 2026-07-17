import { Module } from '@nestjs/common';
import { ClobClient } from './clients/clob.client';
import { GammaClient } from './clients/gamma.client';
import { CtfClient } from './clients/ctf.client';

@Module({ providers: [ClobClient, GammaClient, CtfClient], exports: [ClobClient, GammaClient, CtfClient] })
export class PolymarketModule {}
