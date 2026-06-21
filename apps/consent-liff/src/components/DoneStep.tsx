import { closeLiff } from '../lib/liff-client.js';

/** Step 3: 送信完了。LIFF を閉じるボタンを出す。 */
export default function DoneStep() {
  return (
    <div className="space-y-5 pt-10 text-center">
      <div
        className="mx-auto flex h-16 w-16 items-center justify-center rounded-full text-3xl font-bold text-white"
        style={{ background: '#06C755' }}
        aria-hidden="true"
      >
        &#10003;
      </div>
      <h1 className="text-2xl font-bold text-neutral-900">ご登録ありがとうございました</h1>
      <p className="text-base leading-relaxed text-neutral-600">
        同意書のご登録が完了しました。
      </p>
      <button
        type="button"
        onClick={closeLiff}
        className="min-h-[44px] w-full rounded-lg bg-neutral-800 py-3 text-base font-semibold text-white hover:bg-neutral-900"
      >
        閉じる
      </button>
    </div>
  );
}
