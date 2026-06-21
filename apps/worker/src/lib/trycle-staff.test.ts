import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildStaffEmailBody,
  classifyInquiry,
  routeInquiry,
  shopLabel,
  notifyStaff,
} from './trycle-staff.js';
import type { Env } from '../index.js';

type Bindings = Env['Bindings'];

// ── Add-D: 問い合わせ分類 (本物 shop-routing.ts) ──────────────────────────────

describe('classifyInquiry', () => {
  it('detects カーボン補修 first (yano-only tag)', () => {
    expect(classifyInquiry('カーボンフレームの補修をお願いしたい')).toBe('carbon');
  });
  it('detects 工賃表 before estimate (order matters)', () => {
    expect(classifyInquiry('工賃表を見たい')).toBe('wage');
  });
  it('detects 同意書', () => {
    expect(classifyInquiry('同意書について')).toBe('consent');
  });
  it('detects 見積/整備 as estimate', () => {
    expect(classifyInquiry('整備の見積もりが欲しい')).toBe('estimate');
  });
  it('detects 予約/来店 as reservation', () => {
    expect(classifyInquiry('来店の予約をしたい')).toBe('reservation');
  });
  it('falls back to other', () => {
    expect(classifyInquiry('こんにちは')).toBe('other');
  });
});

// ── Add-F: 店舗振り分け ───────────────────────────────────────────────────────

describe('routeInquiry', () => {
  it('routes カーボン補修 to 矢野口 regardless of preferred shop', () => {
    const r = routeInquiry('carbon', 'miyagase');
    expect(r.shopId).toBe('yano');
    expect(r.staffEmailKey).toBe('yano_staff');
  });
  it('routes normal tags to the preferred shop', () => {
    const r = routeInquiry('estimate', 'miyagase');
    expect(r.shopId).toBe('miyagase');
    expect(r.staffEmailKey).toBe('miyagase_staff');
  });
  it('defaults to yano when no preferred shop', () => {
    expect(routeInquiry('faq').shopId).toBe('yano');
  });
});

describe('shopLabel', () => {
  it('maps shop ids to labels', () => {
    expect(shopLabel('yano')).toBe('矢野口本店');
    expect(shopLabel('miyagase')).toBe('宮ヶ瀬店');
  });
});

// ── メール本文 ────────────────────────────────────────────────────────────────

describe('buildStaffEmailBody', () => {
  it('includes customer, reason, tag, shop, and manual-mode notice', () => {
    const body = buildStaffEmailBody(
      {
        lineUserId: 'U123',
        customerName: '山田',
        reason: '見積後相談',
        estimateSummary: null,
        pdfUrl: null,
        note: null,
      },
      routeInquiry('estimate'),
    );
    expect(body).toContain('山田');
    expect(body).toContain('U123');
    expect(body).toContain('見積後相談');
    expect(body).toContain('estimate');
    expect(body).toContain('矢野口本店');
    expect(body).toContain('有人モード');
  });

  it('embeds estimate summary and pdf url when present', () => {
    const body = buildStaffEmailBody(
      {
        lineUserId: 'U1',
        customerName: null,
        reason: '来店予定',
        estimateSummary: '・ブレーキ調整\n小計: 2000円',
        pdfUrl: 'https://drive/x.pdf',
        note: '来店: 6/25 14:00',
      },
      routeInquiry('estimate'),
    );
    expect(body).toContain('(名前未取得)');
    expect(body).toContain('ブレーキ調整');
    expect(body).toContain('https://drive/x.pdf');
    expect(body).toContain('来店: 6/25 14:00');
  });
});

// ── notifyStaff (Gmail 通知 + 自動タグ/振り分け) ───────────────────────────────

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

  it('POSTs a gmail_notify GAS request with recipient + tag + shop', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const res = await notifyStaff(env(), { ...input, inquiryText: 'カーボン補修' });
    expect(res.ok).toBe(true);
    expect(res.tag).toBe('carbon');
    expect(res.shopId).toBe('yano');
    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.type).toBe('gmail_notify');
    expect(body.payload.to).toBe('staff@example.com');
    expect(body.payload.tag).toBe('carbon');
    expect(body.payload.shop_id).toBe('yano');
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
