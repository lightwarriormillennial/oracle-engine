import { Module } from '@nestjs/common';
import { LeadingSignalStrategy } from './signals/leading-signal.strategy';

@Module({ providers: [LeadingSignalStrategy], exports: [LeadingSignalStrategy] })
export class SignalEngineModule {}
