import { useEffect, useState } from 'react';
import { fetchConsentDocument, submitConsent, type ConsentDocument } from './lib/api-client.js';
import ConsentForm, { type ConsentInput } from './components/ConsentForm.js';
import ConfirmStep from './components/ConfirmStep.js';
import DoneStep from './components/DoneStep.js';

type Step = 'form' | 'confirm' | 'done';

const EMPTY_INPUT: ConsentInput = {
  name: '',
  kana: '',
  phone: '',
  address: '',
  email: '',
  monthlyDistance: '',
  agreed: false,
};

/**
 * 同意書 LIFF の状態機械: form (Step 1) → confirm (Step 2) → done (Step 3)。
 * 入力値は App で保持し、修正 (confirm → form) で入力を保つ。
 */
export default function App() {
  const [step, setStep] = useState<Step>('form');
  const [document, setDocument] = useState<ConsentDocument | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [input, setInput] = useState<ConsentInput>(EMPTY_INPUT);

  useEffect(() => {
    let cancelled = false;
    fetchConsentDocument()
      .then((doc) => {
        if (!cancelled) setDocument(doc);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : '同意書の取得に失敗しました');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadError) {
    return (
      <Shell>
        <p className="text-base text-red-600">{loadError}</p>
      </Shell>
    );
  }

  if (!document) {
    return (
      <Shell>
        <p className="text-base text-neutral-500">読み込み中...</p>
      </Shell>
    );
  }

  async function handleSubmit(confirmationScreenShownAt: string): Promise<void> {
    if (!document) return;
    await submitConsent({
      name: input.name,
      kana: input.kana,
      phone: input.phone,
      address: input.address,
      email: input.email,
      monthlyDistance: input.monthlyDistance,
      consentDocumentVersion: document.version,
      confirmationScreenShownAt,
    });
    setStep('done');
  }

  return (
    <Shell>
      {step === 'form' && (
        <ConsentForm
          document={document}
          initial={input}
          onProceed={(next) => {
            setInput(next);
            setStep('confirm');
          }}
        />
      )}
      {step === 'confirm' && (
        <ConfirmStep
          documentVersion={document.version}
          input={input}
          onBack={() => setStep('form')}
          onSubmit={handleSubmit}
        />
      )}
      {step === 'done' && <DoneStep />}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-md px-4 py-6">{children}</div>;
}
