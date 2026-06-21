// LIFF SDK の薄いラッパ。
//
// 認証方式 (Pkg1 LIFF 案 B):
//   line_user_id は liff.getProfile() で取得し、改竄防止のため
//   liff.getAccessToken() の access_token を bot endpoint へ渡す。bot 側で
//   LINE Profile API (https://api.line.me/v2/profile) を叩いて access_token と
//   line_user_id の一致を verify する (services/consent.ts)。
import liff from '@line/liff';

interface LiffSession {
  readonly lineUserId: string;
  readonly accessToken: string;
}

let _session: LiffSession | null = null;

/**
 * LIFF を初期化し、ログイン済みならプロフィール + access_token を確保する。
 * 未ログインなら liff.login() にリダイレクトする (この関数は戻らない)。
 */
export async function initLiff(): Promise<void> {
  const liffId =
    new URL(window.location.href).searchParams.get('liffId') ??
    (import.meta.env.VITE_LIFF_ID as string | undefined);
  if (!liffId) {
    throw new Error('LIFF ID が未設定です。?liffId=... を付与するか VITE_LIFF_ID を設定してください。');
  }
  await liff.init({ liffId });
  if (!liff.isLoggedIn()) {
    liff.login();
    return;
  }
  const profile = await liff.getProfile();
  const accessToken = liff.getAccessToken();
  if (!accessToken) {
    throw new Error('access_token を取得できませんでした。');
  }
  _session = { lineUserId: profile.userId, accessToken };
}

export function getSession(): LiffSession {
  if (!_session) {
    throw new Error('LIFF is not initialized');
  }
  return _session;
}

export function closeLiff(): void {
  try {
    if (liff.isInClient()) {
      liff.closeWindow();
      return;
    }
  } catch {
    /* fall through to window.close */
  }
  window.close();
}
