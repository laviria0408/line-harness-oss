/**
 * Pkg1 整備見積の「分岐カタログ (正本)」。
 *
 * 本物 trycle-line-harness/src/data/regions.ts を verbatim 移植 (107 tests pass・正本)。
 * region(部位) → symptom(作業) → variant(種類・排他別単価) → qty(数量) の階層が、
 * Pkg1 症状ヒアリングの分岐を一意に決める。UX 軸 (どこを直したいか) で分類した
 * 固定カタログであり、DB の labor_master.category を distinct したものではない
 * (3 軸監査 /tmp/pkg1-3way-diff.md・設計 v1.2.1 §3 経路 B)。
 *
 * - variant は「工賃そのものが変わる排他選択」。各 variant が別 `sample`
 *   (= labor の code/id) を持ち、findLaborByCode で単価を引く。surcharge は加算。
 * - `sample === null` は「その他」等で確定額を出せず → スタッフ送り。
 * - `qty: 'pair' | 'count'` の作業は数量ステップを挟む (v1.2.1: 数量制限なし)。
 *
 * 文言・id・金額の根拠は田渕様提出 CSV (= labor_master canonical)。値はここに持たず、
 * sample (= labor code) 経由で Supabase labor_master を引く。
 */

export interface Surcharge {
  readonly name: string;
  readonly amount: number;
}

export interface Variant {
  readonly label: string;
  /** labor_master の code。null = 「その他」等で確定額を出せず → スタッフ送り。 */
  readonly sample: string | null;
  readonly surcharge?: Surcharge;
}

export interface Symptom {
  readonly label: string;
  /** 単一作業の場合は sample (labor_master code)。null = スタッフ送り。 */
  readonly sample?: string | null;
  /** 種類/左右/内外装で工賃が変わる場合は variants で選ばせる (排他別単価)。 */
  readonly variants?: ReadonlyArray<Variant>;
  /** 'pair' = 前後/両側 (2 本 or 1 本)・'count' = 本数。未指定は 1。 */
  readonly qty?: 'pair' | 'count';
}

export interface Region {
  /** postback value。Carousel column のキーに使う。 */
  readonly value: string;
  readonly label: string;
  readonly symptoms: ReadonlyArray<Symptom> | null; // null = 自由記述 → スタッフ送り
  /**
   * region の種別 (Phase 4・v1.6)。未指定 = 通常の症状ヒアリング region。
   *   - 'overhaul': 包括メンテゲート (A2)。symptom 階層を持たず、専用 handler で
   *     maintenance_menus 4 件の Flex carousel + 違いマトリクスを出す。
   */
  readonly kind?: 'overhaul';
}

export const REGIONS: ReadonlyArray<Region> = [
  {
    // 包括メンテ (A2・Phase 4 v1.6)。symptom 階層を持たず、専用 handler が
    // maintenance_menus 4 件 (OH プレミアム/スタンダード/ライト + ライトメンテ) の
    // Flex carousel + オーバーホール違いマトリクスを出す。選んだメニューは
    // labor_master 経由で通常 cart に積み、variant/qty を持たないので確認へ直行する。
    value: 'overhaul-gate',
    label: '包括メンテ（オーバーホール）',
    symptoms: null,
    kind: 'overhaul',
  },
  {
    // オーバーホール関係 (コンポーネント関係のみ)。OH 本体・バラカンは第一弾スコープ外。
    value: 'overhaul-related',
    label: 'オーバーホール関係',
    symptoms: [
      { label: 'コンポーネント組付け', sample: 'component-assemble' },
      { label: 'コンポーネント組み換え', sample: 'component-swap' },
      { label: 'フレームパーツバラシ', sample: 'frame-parts-strip' },
      { label: 'その他', sample: null },
    ],
  },
  {
    value: 'brake',
    label: 'ブレーキ関係',
    symptoms: [
      {
        label: 'ブレーキ調整',
        variants: [
          { label: '両側', sample: 'brake-adjust-both' },
          { label: '片側のみ', sample: 'brake-adjust-one' },
        ],
      },
      {
        label: 'ブレーキワイヤー交換',
        variants: [
          { label: 'インナーのみ', sample: 'brake-inner-wire' },
          { label: 'アウター＋インナー', sample: 'brake-outer-inner-wire' },
        ],
      },
      {
        label: '油圧まわり（ホース/オイル）',
        variants: [
          { label: '油圧ホース交換（内装・フルード込み）', sample: 'brake-hydraulic-hose-internal' },
          { label: '油圧ホース交換（外装）', sample: 'brake-hydraulic-hose-external' },
          { label: 'ブレーキオイル交換（片側）', sample: 'brake-fluid-swap' },
        ],
      },
      {
        label: 'パッド/シュー交換',
        variants: [
          { label: 'ディスクパッド（片側）', sample: 'brake-disc-pad-swap' },
          { label: 'シュー キャリパー（片側）', sample: 'brake-shoe-caliper' },
          { label: 'シュー カンチ（片側）', sample: 'brake-shoe-canti' },
          { label: 'シュー V（片側）', sample: 'brake-shoe-v' },
        ],
      },
      { label: 'ブレーキローター交換（片側）', sample: 'brake-rotor-swap' },
      {
        label: 'ブレーキ本体交換',
        variants: [
          { label: 'キャリパー（リム・片側）', sample: 'brake-body-caliper' },
          { label: 'カンチ（片側）', sample: 'brake-body-canti' },
          { label: 'V ブレーキ（片側）', sample: 'brake-body-v' },
          { label: 'メカディスク（片側）', sample: 'brake-body-mech-disc' },
          { label: '油圧ディスク（片側）', sample: 'brake-body-hydro-disc' },
        ],
      },
      {
        label: 'ブレーキレバー交換',
        variants: [
          { label: 'ワイヤー式（左右）', sample: 'brake-lever-wire' },
          { label: '油圧式（左右）', sample: 'brake-lever-hydro' },
        ],
      },
      {
        label: 'デュアルレバー（STI）交換',
        variants: [
          { label: 'ワイヤー式（左右）', sample: 'sti-wire' },
          { label: '油圧式（左右）', sample: 'sti-hydro' },
        ],
      },
      { label: 'その他', sample: null },
    ],
  },
  {
    value: 'shift',
    label: '変速関係',
    symptoms: [
      {
        label: 'シフト調整',
        variants: [
          { label: '前後', sample: 'shift-adjust-both' },
          { label: '片側のみ', sample: 'shift-adjust-one' },
        ],
      },
      {
        label: 'シフトワイヤー交換（1本）',
        variants: [
          { label: 'インナーのみ', sample: 'shift-inner-wire' },
          { label: 'アウター＋インナー', sample: 'shift-outer-inner-wire' },
        ],
      },
      {
        label: 'ディレイラー交換',
        variants: [
          { label: 'リア（RD）', sample: 'rd-swap' },
          { label: 'フロント（FD）', sample: 'fd-swap' },
        ],
      },
      { label: 'シフトレバー交換（左右）', sample: 'shift-lever-swap' },
      { label: 'プーリー交換（テンション・ガイド）', sample: 'pulley-swap' },
      { label: 'プーリーケージ交換', sample: 'pulley-cage-swap' },
      { label: 'リアエンド修正', sample: 'rear-end-fix' },
      { label: 'リアエンド交換', sample: 'rear-end-swap' },
      { label: 'Di2 アップデート', sample: 'di2-update' },
      { label: 'その他', sample: null },
    ],
  },
  {
    value: 'drivetrain',
    label: 'ドライブトレイン関係',
    symptoms: [
      { label: 'チェーン交換', sample: 'chain-swap' },
      { label: 'チェーンリング交換', sample: 'chainring-swap' },
      { label: 'クランク交換', sample: 'crank-swap' },
      { label: 'スプロケット交換', sample: 'sprocket-swap' },
      { label: 'BB 交換', sample: 'bb-swap' },
      { label: 'BB グリスアップ', sample: 'bb-grease' },
      { label: 'その他', sample: null },
    ],
  },
  {
    value: 'wheel',
    label: 'ホイール関係',
    symptoms: [
      {
        label: 'ホイール交換',
        variants: [
          { label: 'クリンチャー（前後）', sample: 'wheel-swap-clincher' },
          { label: 'チューブレス（前後）', sample: 'wheel-swap-tubeless' },
          { label: 'チューブレスレディ（前後）', sample: 'wheel-swap-tubeless-ready' },
        ],
      },
      {
        label: 'ホイール振れ取り',
        qty: 'count',
        variants: [
          { label: '通常（1本）', sample: 'wheel-true-1' },
          { label: 'スポークテンション UP 込み', sample: 'wheel-tension-up' },
        ],
      },
      { label: 'スポーク交換', sample: 'spoke-swap', qty: 'count' },
      { label: 'スポーク作成（カット長さ調整・1本）', sample: 'spoke-make-cut', qty: 'count' },
      {
        label: 'ホイール組み立て',
        variants: [
          { label: 'フロント', sample: 'wheel-build-front' },
          { label: 'リア', sample: 'wheel-build-rear' },
        ],
      },
      { label: 'ホイールバラし', sample: 'wheel-strip' },
      { label: 'ホイールバランス（1本）', sample: 'wheel-balance', qty: 'count' },
      {
        label: 'ハブグリスアップ',
        variants: [
          { label: 'フロント（カップ&コーン）', sample: 'front-hub-grease-cnc' },
          { label: 'リア（カップ&コーン）', sample: 'rear-hub-grease-cnc' },
          { label: 'フロント（カートリッジ）', sample: 'front-hub-grease-cart' },
          { label: 'リア（カートリッジ）', sample: 'rear-hub-grease-cart' },
        ],
      },
      { label: 'ハブベアリング交換', sample: 'hub-bearing-swap', qty: 'count' },
      { label: 'その他', sample: null },
    ],
  },
  {
    value: 'tire',
    label: 'タイヤ関係',
    symptoms: [
      { label: 'パンク修理', sample: 'tube-swap', qty: 'pair' },
      {
        label: 'タイヤ交換',
        qty: 'pair',
        variants: [
          { label: 'クリンチャー', sample: 'tire-swap-clincher' },
          { label: 'チューブレス', sample: 'tire-swap-tubeless' },
          { label: 'チューブレスレディ', sample: 'tire-swap-tubeless-ready' },
          { label: 'チューブラーテープ', sample: 'tubular-tape' },
          { label: 'チューブラーセメント', sample: 'tubular-cement' },
          { label: 'チューブラーセメント（シクロ貼り）', sample: 'tubular-cement-cyclo' },
        ],
      },
      { label: 'チューブ交換', sample: 'tube-swap', qty: 'pair' },
      { label: 'リムテープ交換', sample: 'rim-tape-swap', qty: 'count' },
      { label: 'チューブレステープ交換', sample: 'tire-tubeless-tape', qty: 'count' },
      { label: 'シーラント注入', sample: 'sealant-add', qty: 'pair' },
      { label: 'シーラント交換', sample: 'sealant-swap', qty: 'pair' },
      { label: 'マクハル', sample: 'makuhal', qty: 'pair' },
      { label: 'その他', sample: null },
    ],
  },
  {
    value: 'cockpit-head-fork',
    label: 'ヘッド・ハンドル・フォーク関係',
    symptoms: [
      { label: 'ヘッド調整', sample: 'head-adjust' },
      {
        label: 'ヘッドグリスアップ',
        variants: [
          { label: 'スレッド', sample: 'head-grease-thread' },
          { label: 'インテグラル', sample: 'head-grease-integral' },
        ],
      },
      {
        label: 'ヘッドパーツ交換',
        variants: [
          { label: 'スレッド（1個）', sample: 'head-parts-thread' },
          { label: 'インテグラル', sample: 'head-parts-integral' },
        ],
      },
      {
        label: 'ドロップハンドル交換',
        variants: [
          { label: '外装', sample: 'handle-drop-external' },
          { label: '内装（機械式）', sample: 'handle-drop-internal' },
          { label: '内装（油圧）', sample: 'handle-drop-internal', surcharge: { name: '内装・油圧加算', amount: 11000 } },
          { label: 'フル内装（機械式）', sample: 'handle-drop-full-internal' },
          { label: 'フル内装（油圧）', sample: 'handle-drop-full-internal', surcharge: { name: 'フル内装・油圧加算', amount: 11000 } },
        ],
      },
      { label: 'フラットハンドル交換', sample: 'handle-flat' },
      {
        label: 'ステム交換',
        variants: [
          { label: '外装', sample: 'stem-external' },
          { label: '内装（機械式）', sample: 'stem-internal' },
          { label: '内装（油圧）', sample: 'stem-internal', surcharge: { name: '内装・油圧加算', amount: 11000 } },
        ],
      },
      { label: 'バーテープ交換', sample: 'bar-tape' },
      {
        label: 'コラムカット',
        variants: [
          { label: 'リム', sample: 'fork-cut-rim' },
          { label: 'ディスク', sample: 'fork-cut-disc' },
        ],
      },
      { label: 'その他', sample: null },
    ],
  },
  {
    value: 'other-parts',
    label: 'その他関係',
    symptoms: [
      { label: 'ペダル交換', sample: 'pedal-swap' },
      { label: 'ペダルグリスアップ', sample: 'pedal-grease' },
      { label: 'サドル交換', sample: 'saddle-swap' },
      { label: 'シートポスト交換', sample: 'seatpost-swap' },
      { label: 'シートポストカット', sample: 'seatpost-cut' },
      { label: 'クリート交換', sample: 'cleat-swap' },
      { label: 'ブラケットフード交換', sample: 'bracket-hood-swap' },
      { label: 'ライトメンテナンス', sample: 'light-maintenance' },
      { label: 'ボトルゲージ台座修理', sample: 'bottle-cage-fix' },
      { label: 'ディスクブレーキマウントフェイシング', sample: 'disc-mount-facing' },
      { label: 'BB フェイシング', sample: 'bb-facing' },
      { label: 'BB タップ', sample: 'bb-tap' },
      { label: '異音解消', sample: 'noise-fix' },
      { label: '事故見積', sample: 'accident-estimate' },
      { label: 'その他', sample: null },
    ],
  },
  {
    value: 'other',
    label: 'その他（自由記述）',
    symptoms: null,
  },
];

/** value から region を引く。 */
export function findRegionByValue(value: string): Region | undefined {
  return REGIONS.find((region) => region.value === value);
}
