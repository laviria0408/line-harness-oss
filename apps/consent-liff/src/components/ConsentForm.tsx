import { useState } from 'react';
import type { ConsentDocument as ConsentDocumentData } from '../lib/api-client.js';
import ConsentDocument from './ConsentDocument.js';

export interface ConsentInput {
  name: string;
  kana: string;
  phone: string;
  address: string;
  email: string;
  monthlyDistance: string;
  agreed: boolean;
}

interface ConsentFormProps {
  document: ConsentDocumentData;
  initial: ConsentInput;
  onProceed: (input: ConsentInput) => void;
}

// a11y (案 B 改善点 ③): 入力欄・ボタンは min-h-[44px] でタップ領域 >=44px、
// 本文は text-base (16px)、コントラストは neutral/blue で WCAG AA 以上。
const FIELD_CLASS =
  'mt-1 w-full min-h-[44px] rounded-lg border border-neutral-300 px-3 text-base ' +
  'focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-200';

/**
 * Step 1: 同意書文面の表示 + 氏名・電話番号入力 + clickwrap チェックボックス。
 * clickwrap (能動的なチェック操作) は電子契約法・APPI 上、同意の有効性を高める
 * (browse-wrap より同意成立率・証跡が強い)。
 */
export default function ConsentForm({ document, initial, onProceed }: ConsentFormProps) {
  const [name, setName] = useState(initial.name);
  const [kana, setKana] = useState(initial.kana);
  const [phone, setPhone] = useState(initial.phone);
  const [address, setAddress] = useState(initial.address);
  const [email, setEmail] = useState(initial.email);
  const [monthlyDistance, setMonthlyDistance] = useState(initial.monthlyDistance);
  const [agreed, setAgreed] = useState(initial.agreed);
  const [error, setError] = useState<string | null>(null);

  function handleProceed(): void {
    if (name.trim().length === 0) {
      setError('お名前を入力してください。');
      return;
    }
    if (kana.trim().length === 0) {
      setError('ふりがなを入力してください。');
      return;
    }
    if (phone.trim().length === 0) {
      setError('電話番号を入力してください。');
      return;
    }
    if (!agreed) {
      setError('同意書の内容にご同意ください。');
      return;
    }
    setError(null);
    onProceed({
      name: name.trim(),
      kana: kana.trim(),
      phone: phone.trim(),
      address: address.trim(),
      email: email.trim(),
      monthlyDistance: monthlyDistance.trim(),
      agreed,
    });
  }

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-bold text-neutral-900">{document.title}</h1>

      <div className="max-h-[40vh] overflow-y-auto rounded-lg border border-neutral-200 bg-neutral-50 p-4">
        <ConsentDocument bodyMd={document.body_md} />
      </div>

      <label className="block">
        <span className="text-base font-medium text-neutral-800">お名前</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={FIELD_CLASS}
          autoComplete="name"
          placeholder="山田 太郎"
        />
      </label>

      <label className="block">
        <span className="text-base font-medium text-neutral-800">ふりがな</span>
        <input
          type="text"
          value={kana}
          onChange={(e) => setKana(e.target.value)}
          className={FIELD_CLASS}
          placeholder="やまだ たろう"
        />
      </label>

      <label className="block">
        <span className="text-base font-medium text-neutral-800">電話番号</span>
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className={FIELD_CLASS}
          autoComplete="tel"
          inputMode="tel"
          placeholder="09012345678"
        />
      </label>

      <label className="block">
        <span className="text-base font-medium text-neutral-800">
          住所 <span className="text-neutral-500">(任意)</span>
        </span>
        <input
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          className={FIELD_CLASS}
          autoComplete="street-address"
          placeholder="東京都〇〇区〇〇 1-2-3"
        />
      </label>

      <label className="block">
        <span className="text-base font-medium text-neutral-800">
          メールアドレス <span className="text-neutral-500">(任意)</span>
        </span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={FIELD_CLASS}
          autoComplete="email"
          inputMode="email"
          placeholder="example@example.com"
        />
      </label>

      <label className="block">
        <span className="text-base font-medium text-neutral-800">
          月間走行距離 <span className="text-neutral-500">(任意・km)</span>
        </span>
        <input
          type="number"
          value={monthlyDistance}
          onChange={(e) => setMonthlyDistance(e.target.value)}
          className={FIELD_CLASS}
          inputMode="numeric"
          min={0}
          placeholder="200"
        />
      </label>

      <label className="flex min-h-[44px] items-center gap-3 rounded-lg border border-neutral-200 px-3">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="h-5 w-5"
        />
        <span className="text-base text-neutral-800">同意書の内容に同意します</span>
      </label>

      {error && <p className="text-base text-red-600">{error}</p>}

      <button
        type="button"
        onClick={handleProceed}
        className="min-h-[44px] w-full rounded-lg bg-blue-600 py-3 text-base font-semibold text-white hover:bg-blue-700"
      >
        確認画面へ
      </button>
    </div>
  );
}
