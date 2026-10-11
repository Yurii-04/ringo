import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { User } from '@prisma/client';
import { Bot, Context, InlineKeyboard, Keyboard } from 'grammy';
import { AdminService } from '../admin/admin.service';
import { CallsService } from '../calls/calls.service';
import { escapeHtml } from '../calls/call-report';
import { DomainError } from '../common/domain-error';
import { uah } from '../common/money';
import { maskPhone, normalizeUaPhone } from '../common/phone';
import { APP_CONFIG, AppConfig } from '../config/config';
import { ModerationService, TOPIC_MAX_LENGTH, TOPIC_MIN_LENGTH } from '../moderation/moderation.service';
import { PaymentsService } from '../payments/payments.service';
import { CUSTOM_SCENARIO_KEY, SCENARIOS, findScenario } from '../scenarios/scenarios';
import { TELEGRAM_BOT } from '../telegram/tokens';
import { UsersService } from '../users/users.service';
import { CallDraft, DraftStore } from './draft-store';
import { BTN, WELCOME, rulesText } from './texts';

type Ctx = Context & { user?: User };

const STATUS_EMOJI: Record<string, string> = {
  QUEUED: '⏳',
  DIALING: '📞',
  COMPLETED: '✅',
  NO_ANSWER: '📵',
  VOICEMAIL: '📼',
  FAILED: '⚠️',
};

@Injectable()
export class BotService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);

  constructor(
    @Inject(TELEGRAM_BOT) private readonly bot: Bot<Ctx>,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly users: UsersService,
    private readonly calls: CallsService,
    private readonly payments: PaymentsService,
    private readonly moderation: ModerationService,
    private readonly admin: AdminService,
    private readonly drafts: DraftStore,
  ) {}

  onApplicationBootstrap(): void {
    this.register();
    if (!this.config.BOT_POLLING) return;
    void this.bot.start({ onStart: (me) => this.logger.log(`Bot @${me.username} started (long polling)`) });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.bot.isRunning()) await this.bot.stop();
  }

  private isAdmin(ctx: Ctx): boolean {
    return !!ctx.from && this.config.ADMIN_TELEGRAM_IDS.includes(BigInt(ctx.from.id));
  }

  private mainMenu() {
    return new Keyboard().text(BTN.call).row().text(BTN.balance).text(BTN.topup).row().text(BTN.history).text(BTN.rules).resized();
  }

  private register(): void {
    const bot = this.bot;

    bot.catch((err) => this.logger.error(`Bot error: ${err.message}`, (err.error as Error)?.stack));

    // Load/create user; stop blocked users.
    bot.use(async (ctx, next) => {
      if (!ctx.from || ctx.chat?.type !== 'private') return;
      ctx.user = await this.users.upsertFromTelegram(ctx.from);
      if (ctx.user.isBlocked && !this.isAdmin(ctx)) {
        await ctx.reply('⛔ Ваш акаунт заблоковано за порушення правил.');
        return;
      }
      await next();
    });

    bot.command('start', (ctx) => this.onStart(ctx));
    bot.callbackQuery('age:yes', async (ctx) => {
      ctx.user = await this.users.confirmAge(ctx.user!.id);
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup();
      await ctx.reply('Дякую! Обирай дію в меню 👇', { reply_markup: this.mainMenu() });
    });

    this.registerAdmin();

    // Everything below requires the 18+ confirmation.
    bot.use(async (ctx, next) => {
      if (!ctx.user?.ageConfirmedAt) return this.onStart(ctx);
      await next();
    });

    bot.command('rules', (ctx) => this.onRules(ctx));
    bot.hears(BTN.rules, (ctx) => this.onRules(ctx));
    bot.command('balance', (ctx) => this.onBalance(ctx));
    bot.hears(BTN.balance, (ctx) => this.onBalance(ctx));
    bot.command('topup', (ctx) => this.onTopUpMenu(ctx));
    bot.hears(BTN.topup, (ctx) => this.onTopUpMenu(ctx));
    bot.command('history', (ctx) => this.onHistory(ctx));
    bot.hears(BTN.history, (ctx) => this.onHistory(ctx));
    bot.command(['call', 'prank'], (ctx) => this.onNewCall(ctx));
    bot.hears(BTN.call, (ctx) => this.onNewCall(ctx));
    bot.command('cancel', async (ctx) => {
      await this.drafts.clear(ctx.from!.id);
      await ctx.reply('Скасовано.', { reply_markup: this.mainMenu() });
    });

    bot.callbackQuery(/^topup:(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const amount = Number(ctx.match[1]);
      const { url } = await this.payments.createTopUp(ctx.user!.id, amount);
      await ctx.reply(`Поповнення на ${amount} грн через LiqPay:`, {
        reply_markup: new InlineKeyboard().url(`💳 Оплатити ${amount} грн`, url),
      });
    });
    bot.callbackQuery('topup:menu', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.onTopUpMenu(ctx);
    });
    bot.callbackQuery(/^sc:(\w+)$/, (ctx) => this.onScenarioChosen(ctx, ctx.match[1]));
    bot.callbackQuery('call:confirm', (ctx) => this.onConfirm(ctx));
    bot.callbackQuery('call:cancel', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.drafts.clear(ctx.from.id);
      await ctx.editMessageReplyMarkup();
      await ctx.reply('Скасовано.', { reply_markup: this.mainMenu() });
    });

    bot.on('message:text', (ctx) => this.onText(ctx, ctx.message.text));
  }

  private registerAdmin(): void {
    const adminOnly = (handler: (ctx: Ctx, args: string[]) => Promise<string>) => async (ctx: Ctx) => {
      if (!this.isAdmin(ctx)) return;
      const args = (typeof ctx.match === 'string' ? ctx.match : '').trim().split(/\s+/).filter(Boolean);
      await ctx.reply(await handler(ctx, args), { parse_mode: 'HTML' });
    };
    const usage = (text: string) => `Використання: <code>${escapeHtml(text)}</code>`;

    this.bot.command('stats', adminOnly(() => this.admin.stats()));
    this.bot.command('block_user', adminOnly(async (_, [ref]) => (ref ? this.admin.setUserBlocked(ref, true) : usage('/block_user <telegram_id|@username>'))));
    this.bot.command('unblock_user', adminOnly(async (_, [ref]) => (ref ? this.admin.setUserBlocked(ref, false) : usage('/unblock_user <telegram_id|@username>'))));
    this.bot.command('block_phone', adminOnly(async (_, [phone, ...rest]) => (phone ? this.admin.blockPhone(phone, rest.join(' ') || undefined) : usage('/block_phone <+380...> [коментар]'))));
    this.bot.command('unblock_phone', adminOnly(async (_, [phone]) => (phone ? this.admin.unblockPhone(phone) : usage('/unblock_phone <+380...>'))));
    this.bot.command('add_balance', adminOnly(async (_, [ref, amount, ...rest]) => (ref && amount ? this.admin.adjustBalance(ref, Number(amount), rest.join(' ') || undefined) : usage('/add_balance <telegram_id|@username> <грн> [коментар]'))));
  }

  private async onStart(ctx: Ctx): Promise<void> {
    if (!ctx.user?.ageConfirmedAt) {
      await ctx.reply(`${WELCOME}\n\n${this.rules()}`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('✅ Мені є 18 років, погоджуюсь', 'age:yes'),
      });
      return;
    }
    await ctx.reply(`З поверненням! Баланс: ${uah(ctx.user.balance)}.`, { reply_markup: this.mainMenu() });
  }

  private rules(): string {
    const c = this.config;
    return rulesText(c.CALL_PRICE, c.CALLS_PER_NUMBER_PER_DAY, c.CALLS_PER_NUMBER_PER_WEEK, c.MAX_CALL_DURATION_SEC);
  }

  private onRules(ctx: Ctx) {
    return ctx.reply(this.rules(), { parse_mode: 'HTML' });
  }

  private onBalance(ctx: Ctx) {
    return ctx.reply(`💰 Баланс: <b>${uah(ctx.user!.balance)}</b>\nВартість дзвінка: ${uah(this.config.CALL_PRICE)}`, {
      parse_mode: 'HTML',
    });
  }

  private onTopUpMenu(ctx: Ctx) {
    const kb = new InlineKeyboard();
    for (const amount of this.config.TOPUP_OPTIONS_UAH) kb.text(`${amount} грн`, `topup:${amount}`);
    return ctx.reply('Оберіть суму поповнення:', { reply_markup: kb });
  }

  private async onHistory(ctx: Ctx) {
    const calls = await this.calls.listRecent(ctx.user!.id);
    if (!calls.length) return ctx.reply('Ви ще не замовляли розіграшів.');
    const lines = calls.map((c) => {
      const title = c.scenarioKey === CUSTOM_SCENARIO_KEY ? 'Власна тема' : findScenario(c.scenarioKey ?? '')?.title ?? '—';
      const date = c.createdAt.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
      return `${STATUS_EMOJI[c.status] ?? ''} ${date} · ${maskPhone(c.toNumber)} · ${escapeHtml(title)}${c.refunded ? ' · повернено' : ''}`;
    });
    return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  }

  private async onNewCall(ctx: Ctx) {
    await this.drafts.set(ctx.from!.id, { step: 'phone' });
    await ctx.reply('Введіть номер друга у форматі <code>+380XXXXXXXXX</code> (або /cancel):', { parse_mode: 'HTML' });
  }

  private async onText(ctx: Ctx, text: string): Promise<void> {
    const draft = await this.drafts.get(ctx.from!.id);
    if (!draft) {
      await ctx.reply('Оберіть дію в меню 👇', { reply_markup: this.mainMenu() });
      return;
    }

    switch (draft.step) {
      case 'phone': {
        const phone = normalizeUaPhone(text);
        if (!phone) {
          await ctx.reply('❌ Це не схоже на український мобільний номер. Приклад: +380671234567');
          return;
        }
        await this.drafts.set(ctx.from!.id, { ...draft, step: 'scenario', phone });
        const kb = new InlineKeyboard();
        for (const s of SCENARIOS) kb.text(s.title, `sc:${s.key}`).row();
        kb.text('✍️ Своя тема', `sc:${CUSTOM_SCENARIO_KEY}`);
        const list = SCENARIOS.map((s) => `<b>${s.title}</b> — ${escapeHtml(s.description)}`).join('\n');
        await ctx.reply(`Оберіть сценарій:\n\n${list}`, { parse_mode: 'HTML', reply_markup: kb });
        return;
      }
      case 'topic': {
        const topic = text.trim();
        if (topic.length < TOPIC_MIN_LENGTH || topic.length > TOPIC_MAX_LENGTH) {
          await ctx.reply(`Опишіть тему в ${TOPIC_MIN_LENGTH}–${TOPIC_MAX_LENGTH} символах.`);
          return;
        }
        await this.drafts.set(ctx.from!.id, { ...draft, step: 'name', customTopic: topic });
        await this.askName(ctx);
        return;
      }
      case 'name': {
        const verdict = this.moderation.checkCustomerName(text);
        if (!verdict.allowed) {
          await ctx.reply(`❌ ${verdict.reason}`);
          return;
        }
        const next: CallDraft = { ...draft, step: 'confirm', customerName: text.trim() };
        await this.drafts.set(ctx.from!.id, next);
        await this.showConfirmation(ctx, next);
        return;
      }
      default:
        await ctx.reply('Скористайтеся кнопками вище або /cancel.');
    }
  }

  private async onScenarioChosen(ctx: Ctx, key: string) {
    await ctx.answerCallbackQuery();
    const draft = await this.drafts.get(ctx.from!.id);
    if (!draft || draft.step !== 'scenario') return;
    if (key === CUSTOM_SCENARIO_KEY) {
      await this.drafts.set(ctx.from!.id, { ...draft, step: 'topic', scenarioKey: key });
      await ctx.reply(
        '✍️ Опишіть тему розіграшу (до 500 символів). Наприклад: «сусід знизу просить провести кастинг його папуги».\n\n' +
          'Тема пройде модерацію. Заборонено видавати себе за держоргани, ТЦК, поліцію, банки, лікарів; ' +
          'теми «родич у біді», погрози, вимагання грошей чи даних, сексуальний контент і цькування.',
      );
      return;
    }
    if (!findScenario(key)) return;
    await this.drafts.set(ctx.from!.id, { ...draft, step: 'name', scenarioKey: key });
    await this.askName(ctx);
  }

  private askName(ctx: Ctx) {
    return ctx.reply("Як вас представити? Агент наприкінці скаже, від кого розіграш. Введіть ім'я (наприклад, «Оля»):");
  }

  private async showConfirmation(ctx: Ctx, d: CallDraft) {
    const scenario = d.scenarioKey === CUSTOM_SCENARIO_KEY ? `Своя тема: «${escapeHtml(d.customTopic ?? '')}»` : findScenario(d.scenarioKey ?? '')?.title;
    await ctx.reply(
      [
        '<b>Перевірте замовлення</b>',
        `Номер: ${d.phone}`,
        `Сценарій: ${scenario}`,
        `Від кого: ${escapeHtml(d.customerName ?? '')}`,
        `Вартість: ${uah(this.config.CALL_PRICE)} (баланс: ${uah(ctx.user!.balance)})`,
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('✅ Дзвонити', 'call:confirm').text('❌ Скасувати', 'call:cancel'),
      },
    );
  }

  private async onConfirm(ctx: Ctx) {
    await ctx.answerCallbackQuery();
    const draft = await this.drafts.take(ctx.from!.id);
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    if (!draft || draft.step !== 'confirm' || !draft.phone || !draft.scenarioKey || !draft.customerName) {
      await ctx.reply('Замовлення застаріло. Почніть заново.', { reply_markup: this.mainMenu() });
      return;
    }
    if (draft.scenarioKey === CUSTOM_SCENARIO_KEY) await ctx.reply('🔎 Перевіряю тему…');
    try {
      await this.calls.createCall({
        userId: ctx.user!.id,
        phone: draft.phone,
        scenarioKey: draft.scenarioKey,
        customTopic: draft.customTopic,
        customerName: draft.customerName,
      });
      await ctx.reply(
        `📞 Дзвінок поставлено в чергу! Списано ${uah(this.config.CALL_PRICE)}. Я напишу, щойно розмова завершиться.`,
        { reply_markup: this.mainMenu() },
      );
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      const kb = err.code === 'INSUFFICIENT_FUNDS' ? new InlineKeyboard().text('➕ Поповнити', 'topup:menu') : undefined;
      await ctx.reply(`❌ ${err.message}`, { reply_markup: kb });
    }
  }
}
