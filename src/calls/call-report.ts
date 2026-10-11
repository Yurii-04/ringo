import { CallStatus } from '@prisma/client';
import { maskPhone } from '../common/phone';
import { uah } from '../common/money';
import { TranscriptTurn } from '../voice/voice-provider.interface';

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function formatTranscript(turns: TranscriptTurn[]): string {
  return turns
    .map((t) => {
      const m = Math.floor(t.timeSec / 60);
      const s = String(Math.floor(t.timeSec % 60)).padStart(2, '0');
      return `[${m}:${s}] ${t.role === 'agent' ? '🤖 Агент' : '👤 Друг'}: ${t.text}`;
    })
    .join('\n');
}

const STATUS_TEXT: Partial<Record<CallStatus, string>> = {
  COMPLETED: '✅ Дзвінок відбувся',
  NO_ANSWER: '📵 Друг не відповів',
  VOICEMAIL: '📼 Спрацював автовідповідач',
  FAILED: '⚠️ Не вдалося здійснити дзвінок',
};

export function formatCallReport(p: {
  status: CallStatus;
  toNumber: string;
  durationSec?: number | null;
  summary?: string | null;
  refunded: boolean;
  price: number;
  optOut: boolean;
}): string {
  const lines = [`<b>${STATUS_TEXT[p.status] ?? p.status}</b>`, `Номер: ${maskPhone(p.toNumber)}`];
  if (p.status === 'COMPLETED' && p.durationSec) lines.push(`Тривалість: ${p.durationSec} с`);
  if (p.summary) lines.push('', `<i>${escapeHtml(p.summary)}</i>`);
  if (p.refunded) lines.push('', `💸 Кошти (${uah(p.price)}) повернуто на баланс.`);
  if (p.optOut) {
    lines.push(
      '',
      '🚫 Співрозмовник попросив більше не телефонувати. Номер назавжди внесено до блок-листа — ' +
        'на нього більше не можна замовити розіграш.',
    );
  }
  return lines.join('\n');
}
