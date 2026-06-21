import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { ConsentDocument, ConsentSubmission } from './lib/api-client.js';

const sampleDoc: ConsentDocument = {
  id: 'doc-1',
  version: 'v1.0 (2026-06-21)',
  title: '整備同意書',
  body_md: '# 同意事項\n本書に同意します。\n- 項目A\n- 項目B',
};

const fetchConsentDocument = vi.fn<() => Promise<ConsentDocument>>();
const submitConsent = vi.fn<(input: ConsentSubmission) => Promise<void>>();
const closeLiff = vi.fn<() => void>();

vi.mock('./lib/api-client.js', () => ({
  fetchConsentDocument: () => fetchConsentDocument(),
  submitConsent: (input: ConsentSubmission) => submitConsent(input),
}));
vi.mock('./lib/liff-client.js', () => ({
  closeLiff: () => closeLiff(),
}));

// Import after mocks are registered.
const { default: App } = await import('./App.js');

beforeEach(() => {
  cleanup();
  fetchConsentDocument.mockReset().mockResolvedValue(sampleDoc);
  submitConsent.mockReset().mockResolvedValue(undefined);
  closeLiff.mockReset();
});

describe('App step machine', () => {
  test('renders the consent document title once loaded', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('整備同意書')).toBeTruthy());
    expect(screen.getByText('確認画面へ')).toBeTruthy();
  });

  test('blocks progression to confirm until name, phone, and checkbox are set', async () => {
    render(<App />);
    await waitFor(() => screen.getByText('確認画面へ'));

    fireEvent.click(screen.getByText('確認画面へ'));
    expect(screen.getByText('お名前を入力してください。')).toBeTruthy();
    // Still on Step 1.
    expect(screen.queryByText('以下の内容で送信します')).toBeNull();
  });

  test('blocks progression to confirm until kana is set', async () => {
    render(<App />);
    await waitFor(() => screen.getByText('確認画面へ'));

    fireEvent.change(screen.getByPlaceholderText('山田 太郎'), { target: { value: '田中 一郎' } });
    fireEvent.change(screen.getByPlaceholderText('09012345678'), { target: { value: '08011112222' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('確認画面へ'));

    expect(screen.getByText('ふりがなを入力してください。')).toBeTruthy();
    expect(screen.queryByText('以下の内容で送信します')).toBeNull();
  });

  test('renders all optional input fields (address, email, monthly distance)', async () => {
    render(<App />);
    await waitFor(() => screen.getByText('確認画面へ'));

    const email = screen.getByPlaceholderText('example@example.com') as HTMLInputElement;
    const distance = screen.getByPlaceholderText('200') as HTMLInputElement;
    expect(screen.getByPlaceholderText('やまだ たろう')).toBeTruthy();
    expect(screen.getByPlaceholderText('東京都〇〇区〇〇 1-2-3')).toBeTruthy();
    expect(email.type).toBe('email');
    expect(distance.type).toBe('number');
  });

  test('advances form -> confirm -> done and submits the captured payload', async () => {
    render(<App />);
    await waitFor(() => screen.getByText('確認画面へ'));

    fireEvent.change(screen.getByPlaceholderText('山田 太郎'), { target: { value: '田中 一郎' } });
    fireEvent.change(screen.getByPlaceholderText('やまだ たろう'), { target: { value: 'たなか いちろう' } });
    fireEvent.change(screen.getByPlaceholderText('09012345678'), { target: { value: '08011112222' } });
    fireEvent.change(screen.getByPlaceholderText('東京都〇〇区〇〇 1-2-3'), { target: { value: '東京都調布市1-1' } });
    fireEvent.change(screen.getByPlaceholderText('example@example.com'), { target: { value: 'taro@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('200'), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('確認画面へ'));

    // Step 2: confirmation screen with summary.
    expect(screen.getByText('以下の内容で送信します')).toBeTruthy();
    expect(screen.getByText('田中 一郎')).toBeTruthy();
    expect(screen.getByText('たなか いちろう')).toBeTruthy();
    expect(screen.getByText('08011112222')).toBeTruthy();
    expect(screen.getByText('150 km')).toBeTruthy();

    fireEvent.click(screen.getByText('送信'));

    await waitFor(() => expect(screen.getByText('ご登録ありがとうございました')).toBeTruthy());

    expect(submitConsent).toHaveBeenCalledTimes(1);
    const payload = submitConsent.mock.calls[0][0];
    expect(payload.name).toBe('田中 一郎');
    expect(payload.kana).toBe('たなか いちろう');
    expect(payload.phone).toBe('08011112222');
    expect(payload.address).toBe('東京都調布市1-1');
    expect(payload.email).toBe('taro@example.com');
    expect(payload.monthlyDistance).toBe('150');
    expect(payload.consentDocumentVersion).toBe('v1.0 (2026-06-21)');
    expect(typeof payload.confirmationScreenShownAt).toBe('string');
    expect(Number.isNaN(Date.parse(payload.confirmationScreenShownAt))).toBe(false);
  });

  test('advances with optional fields left blank (shown as 未入力)', async () => {
    render(<App />);
    await waitFor(() => screen.getByText('確認画面へ'));

    fireEvent.change(screen.getByPlaceholderText('山田 太郎'), { target: { value: '田中 一郎' } });
    fireEvent.change(screen.getByPlaceholderText('やまだ たろう'), { target: { value: 'たなか いちろう' } });
    fireEvent.change(screen.getByPlaceholderText('09012345678'), { target: { value: '08011112222' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('確認画面へ'));

    expect(screen.getByText('以下の内容で送信します')).toBeTruthy();
    // Optional fields rendered as 未入力 (address / email / monthly distance).
    expect(screen.getAllByText('未入力').length).toBeGreaterThanOrEqual(3);
  });

  test('confirm -> 修正 returns to Step 1 keeping the entered values', async () => {
    render(<App />);
    await waitFor(() => screen.getByText('確認画面へ'));

    fireEvent.change(screen.getByPlaceholderText('山田 太郎'), { target: { value: '佐藤 花子' } });
    fireEvent.change(screen.getByPlaceholderText('やまだ たろう'), { target: { value: 'さとう はなこ' } });
    fireEvent.change(screen.getByPlaceholderText('09012345678'), { target: { value: '07033334444' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('確認画面へ'));

    fireEvent.click(screen.getByText('修正'));
    expect((screen.getByPlaceholderText('山田 太郎') as HTMLInputElement).value).toBe('佐藤 花子');
    expect((screen.getByPlaceholderText('やまだ たろう') as HTMLInputElement).value).toBe('さとう はなこ');
    expect((screen.getByPlaceholderText('09012345678') as HTMLInputElement).value).toBe('07033334444');
  });
});
