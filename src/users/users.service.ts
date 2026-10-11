import { Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface TelegramProfile {
  id: number;
  username?: string;
  first_name?: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  upsertFromTelegram(profile: TelegramProfile): Promise<User> {
    return this.prisma.user.upsert({
      where: { telegramId: BigInt(profile.id) },
      create: { telegramId: BigInt(profile.id), username: profile.username, firstName: profile.first_name },
      update: { username: profile.username, firstName: profile.first_name },
    });
  }

  findByTelegramId(telegramId: bigint): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { telegramId } });
  }

  findByUsername(username: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { username: { equals: username.replace(/^@/, ''), mode: 'insensitive' } } });
  }

  confirmAge(userId: string): Promise<User> {
    return this.prisma.user.update({ where: { id: userId }, data: { ageConfirmedAt: new Date() } });
  }

  setBlocked(userId: string, isBlocked: boolean): Promise<User> {
    return this.prisma.user.update({ where: { id: userId }, data: { isBlocked } });
  }
}
