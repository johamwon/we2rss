import { Module } from '@nestjs/common';
import { AccountCheckService } from './account-check.service';
import { PrismaModule } from '@server/prisma/prisma.module';
import { TrpcModule } from '@server/trpc/trpc.module';

@Module({
  imports: [PrismaModule, TrpcModule],
  providers: [AccountCheckService],
  exports: [AccountCheckService],
})
export class AccountCheckModule {}
