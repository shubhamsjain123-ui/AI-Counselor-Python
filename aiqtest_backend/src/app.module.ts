import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiCounselorModule } from './ai-counselor/ai-counselor.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    AiCounselorModule,
  ],
})
export class AppModule {}
