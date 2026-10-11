import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { BlocklistModule } from '../blocklist/blocklist.module';
import { UsersModule } from '../users/users.module';
import { AdminService } from './admin.service';

@Module({
  imports: [UsersModule, BlocklistModule, BillingModule],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
