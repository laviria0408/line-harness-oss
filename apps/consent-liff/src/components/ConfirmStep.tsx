import { useState } from 'react';
import type { ConsentInput } from './ConsentForm.js';

interface ConfirmStepProps {
  documentVersion: string;
  input: ConsentInput;
  onBack: () => void;
  onSubmit: (confirmationScreenShownAt: string) => Promise<void>;
}

/**
 * Step 2: 確認画面 (誤タップ防止)。「以下の内容で送信します」+ 入力 summary を
 * 表示し、「修正」(Step 1 戻る) と「送信」を出す。送信押下時に確認画面の表示
 * 時刻 (confirmation_screen_shown_at) を ISO 文字列で渡す。これは「ユーザーが
 * 確認画面を見たうえで能動的に送信した」証跡で、電子契約法上の同意成立の補強。
 */
export default function ConfirmStep({ input, onBack, onSubmit }: ConfirmStepProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 確認画面がマウントされた時刻 = ユーザーが確認画面を見た時刻。
  const [shownAt] = useState(() => new Date().toISOString());

  async function handleSubmit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(shownAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : '送信に失敗しました。時間をおいて再度お試しください。');
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-bold text-neutral-900">以下の内容で送信します</h1>

      <dl className="space-y-2 rounded-lg border border-neutral-200 p-4 text-base">
        <Row label="お名前" value={input.name} />
        <Row label="ふりがな" value={input.kana} />
        <Row label="電話番号" value={input.phone} />
        <Row label="住所" value={input.address} />
        <Row label="メールアドレス" value={input.email} />
        <Row
          label="月間走行距離"
          value={input.monthlyDistance ? `${input.monthlyDistance} km` : ''}
        />
        <Row label="同意" value="同意済み" />
      </dl>

      {error && <p className="text-base text-red-600">{error}</p>}

      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          className="min-h-[44px] rounded-lg border-2 border-neutral-300 py-3 text-base font-semibold text-neutral-700 disabled:opacity-50"
        >
          修正
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          className="min-h-[44px] rounded-lg bg-blue-600 py-3 text-base font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? '送信中...' : '送信'}
        </button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const isEmpty = value.trim().length === 0;
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-neutral-600">{label}</dt>
      <dd
        className={
          isEmpty ? 'text-right font-medium text-neutral-400' : 'text-right font-medium text-neutral-900'
        }
      >
        {isEmpty ? '未入力' : value}
      </dd>
    </div>
  );
}
