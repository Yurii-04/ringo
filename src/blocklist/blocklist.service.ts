import { Injectable } from '@nestjs/common';
import { BlockReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Tx } from '../prisma/types';

@Injectable()
export class BlocklistService {
  constructor(private readonly prisma: PrismaService) {}

  async isBlocked(phone: string, tx: Tx | PrismaService = this.prisma): Promise<boolean> {
    const row = await tx.blockedNumber.findUnique({ where: { phone } });
    return row !== null;
  }

  /** Permanent block after the callee asked not to be called again. Overrides admin blocks. */
  async blockOptOut(phone: string, comment?: string): Promise<void> {
    await this.prisma.blockedNumber.upsert({
      where: { phone },
      create: { phone, reason: BlockReason.OPT_OUT, comment },
      update: { reason: BlockReason.OPT_OUT, comment },
    });
  }

  async blockByAdmin(phone: string, comment?: string): Promise<void> {
    await this.prisma.blockedNumber.upsert({
      where: { phone },
      create: { phone, reason: BlockReason.ADMIN, comment },
      update: {},
    });
  }

  /**
   * Removes an admin block. Opt-out blocks are permanent and are never removed.
   * @returns 'removed' | 'opt_out' | 'not_found'
   */
  async unblockByAdmin(phone: string): Promise<'removed' | 'opt_out' | 'not_found'> {
    const row = await this.prisma.blockedNumber.findUnique({ where: { phone } });
    if (!row) return 'not_found';
    if (row.reason === BlockReason.OPT_OUT) return 'opt_out';
    await this.prisma.blockedNumber.delete({ where: { phone } });
    return 'removed';
  }
}
