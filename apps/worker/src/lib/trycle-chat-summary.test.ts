import { describe, it, expect } from 'vitest';
import {
  makeFlowId,
  formatChatSummaryLine,
  appendLineWithCap,
  MAX_SUMMARY_LINES,
  MAX_SUMMARY_CHARS,
  type ChatSummaryEvent,
} from './trycle-chat-summary.js';

// 2026-06-22 14:30 JST = 05:30 UTC (UTC+9)
const AT_JST_1430 = new Date('2026-06-22T05:30:00Z');

describe('makeFlowId', () => {
  it('formats {MMDD-HHMM} in JST', () => {
    expect(makeFlowId(AT_JST_1430)).toBe('0622-1430');
  });

  it('rolls the date forward across the UTC→JST midnight boundary', () => {
    // 2026-06-22 23:00 UTC = 2026-06-23 08:00 JST
    expect(makeFlowId(new Date('2026-06-22T23:00:00Z'))).toBe('0623-0800');
  });

  it('zero-pads single-digit month/day/hour/minute', () => {
    // 2026-01-05 00:09 JST = 2026-01-04 15:09 UTC
    expect(makeFlowId(new Date('2026-01-04T15:09:00Z'))).toBe('0105-0009');
  });
});

describe('formatChatSummaryLine', () => {
  it('renders {HH:mm} [{flow}#{id}] {speaker}「{text}」', () => {
    const event: ChatSummaryEvent = {
      flowType: 'pkg1',
      speaker: '顧客',
      text: '整備見積を依頼',
      at: AT_JST_1430,
    };
    expect(formatChatSummaryLine(event, '0622-1430')).toBe(
      '14:30 [pkg1#0622-1430] 顧客「整備見積を依頼」',
    );
  });

  it('collapses newlines so one event stays one line', () => {
    const event: ChatSummaryEvent = {
      flowType: 'pkg8',
      speaker: 'bot',
      text: '平日\n10:00-19:00',
      at: AT_JST_1430,
    };
    const line = formatChatSummaryLine(event, '0622-1430');
    expect(line.includes('\n')).toBe(false);
    expect(line).toContain('平日 10:00-19:00');
  });

  it('strips inner 鉤括弧 so the wrapping 「」 stays unambiguous', () => {
    const event: ChatSummaryEvent = {
      flowType: 'inquiry',
      speaker: '顧客',
      text: '「駐輪場所」に困ってます',
      at: AT_JST_1430,
    };
    const line = formatChatSummaryLine(event, '0622-1430');
    // 内側の鉤括弧は除去され、外側の 1 組だけが残る。
    expect((line.match(/「/g) ?? []).length).toBe(1);
    expect((line.match(/」/g) ?? []).length).toBe(1);
  });
});

describe('appendLineWithCap', () => {
  it('appends to an empty summary', () => {
    expect(appendLineWithCap(null, 'a')).toBe('a');
    expect(appendLineWithCap('', 'a')).toBe('a');
  });

  it('appends below existing lines (newest last)', () => {
    expect(appendLineWithCap('a\nb', 'c')).toBe('a\nb\nc');
  });

  it('drops blank lines from existing and added content', () => {
    expect(appendLineWithCap('a\n\n', '\nb\n')).toBe('a\nb');
  });

  it('caps to MAX_SUMMARY_LINES keeping the newest lines', () => {
    const existing = Array.from({ length: MAX_SUMMARY_LINES }, (_, i) => `L${i}`).join('\n');
    const result = appendLineWithCap(existing, 'NEW').split('\n');
    expect(result.length).toBe(MAX_SUMMARY_LINES);
    expect(result.at(-1)).toBe('NEW');
    expect(result[0]).toBe('L1'); // L0 dropped
  });

  it('caps to MAX_SUMMARY_CHARS dropping oldest lines', () => {
    const big = 'x'.repeat(MAX_SUMMARY_CHARS);
    const result = appendLineWithCap(big, 'tail');
    expect(result.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(result.endsWith('tail')).toBe(true);
  });
});
