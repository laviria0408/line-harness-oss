import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildStaffEmailBody, notifyStaff } from './trycle-staff.js';
import type { Env } from '../index.js';

type Bindings = Env['Bindings'];

describe('buildStaffEmailBody', () => {
  it('includes customer, reason, and manual-mode notice', () => {
    const body = buildStaffEmailBody({
      lineUserId: 'U123',
      customerName: '山田',
      reason: '見積後相談',
      estimateSummary: null,
      pdfUrl: null,
      note: null,
    });
    expect(body).toContain('山田');
    expect(body).toContain('U123');
    expect(body).toContain('見積後相談');
    expect(body).toContain('有人モード');
  });

  it('embeds estimate summary and pdf url when present', () => {
    const body = buildStaffEmailBody({
      lineUserId: 'U1',
      customerName: null,
      reason: '来店予定',
      estimateSummary: '・ブレーキ調整\n小計: 2000円',
      pdfUrl: 'https://drive/x.pdf',
      note: '来店: 6/25 14:00',
    });
    expect(body).toContain('(名前未取得)');
    expect(body).toContain('ブレーキ調整');
    expect(body).toContain('https://drive/x.pdf');
    expect(body).toContain('来店: 6/25 14:00');
  });
});

describe('notifyStaff', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  function env(o: Partial<Bindings> = {}): Bindings {
    return {
      GAS_WEB_APP_URL: 'https://script.example.com/exec',
      GMAIL_NOTIFICATION_TO: 'staff@example.com',
      ...o,
    } as Bindings;
  }

  const input = {
    lineUserId: 'U1',
    customerName: '田中',
    reason: '相談',
    estimateSummary: null,
    pdfUrl: null,
    note: null,
  };

  it('returns ok=false when GMAIL_NOTIFICATION_TO is unset (no GAS call)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await notifyStaff(env({ GMAIL_NOTIFICATION_TO: undefined }), input);
    expect(res.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('POSTs a gmail_notify GAS request with the recipient', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const res = await notifyStaff(env(), input);
    expect(res.ok).toBe(true);
    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.type).toBe('gmail_notify');
    expect(body.payload.to).toBe('staff@example.com');
  });

  it('surfaces GAS errors as ok=false', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'boom' }), { status: 200 }),
    );
    const res = await notifyStaff(env(), input);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('boom');
  });
});
