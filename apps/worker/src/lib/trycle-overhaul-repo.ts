/**
 * TRYCLE 包括メンテ (A2・Phase 4 v1.6) の Supabase アクセス層。
 *
 * maintenance_menus (OH メニュー拡張・labor_master と 1:1) / maintenance_features
 * (機能項目マスタ) / maintenance_menu_features (メニュー × 機能の ◯/オプション
 * マトリクス) を読み、4 メニューの Flex carousel と「違いマトリクス」Flex を組む素材を返す。
 *
 * canonical は Tenant Supabase 直読み (Pkg8 / Pkg1 と同方針)。
 * 設計: 0028_maintenance_menus_and_features.sql / Pkg1 v1.6
 * (page 386050ad6a7e81f8b701cd52c9201af6)。
 */
import { supabaseSelect } from './supabase.js';
import { getTenantId, type TrycleRepoEnv } from './trycle-repo.js';
import { loadAllLabor, type LaborRow } from './trycle-pkg1-repo.js';

interface MaintenanceMenuRow {
  readonly labor_master_id: string;
  readonly duration_days_min: number | null;
  readonly duration_days_max: number | null;
  readonly detailed_description: string | null;
  readonly hero_image_url: string | null;
  readonly sort_order: number;
}

interface MaintenanceFeatureRow {
  readonly id: string;
  readonly category: string | null;
  readonly name: string;
  readonly sort_order: number;
}

interface MenuFeatureRow {
  readonly labor_master_id: string;
  readonly feature_id: string;
  readonly option_price: number | null;
  readonly option_price_open_ended: boolean;
  readonly notes: string | null;
  readonly sort_order: number;
}

/** Flex 生成に渡す 1 メニューの正規化形 (labor + menu 拡張を合成)。 */
export interface OverhaulMenu {
  readonly laborId: string;
  readonly code: string;
  readonly name: string;
  readonly price: number;
  readonly priceMax: number | null;
  readonly priceOpenEnded: boolean;
  readonly durationDaysMin: number | null;
  readonly durationDaysMax: number | null;
  readonly detailedDescription: string | null;
  readonly heroImageUrl: string | null;
  readonly sortOrder: number;
}

/** 違いマトリクス 1 メニュー分: 含まれる機能 + オプション機能。 */
export interface OverhaulMenuMatrix {
  readonly menu: OverhaulMenu;
  /** option_price IS NULL = 標準で含まれる機能名。 */
  readonly includedFeatures: ReadonlyArray<string>;
  /** option_price あり = オプション機能 (名前 + 料金表記)。 */
  readonly optionalFeatures: ReadonlyArray<OverhaulOption>;
}

export interface OverhaulOption {
  readonly featureName: string;
  /** "¥12,000" / "¥12,000〜" / 'ご相談' 等の表示用文言。 */
  readonly priceLabel: string;
}

/** maintenance_menus を sort_order 昇順で取得し labor_master と合成して返す。 */
export async function listOverhaulMenus(env: TrycleRepoEnv): Promise<OverhaulMenu[]> {
  const tenantId = getTenantId(env);
  const [menuRows, labors] = await Promise.all([
    supabaseSelect<MaintenanceMenuRow>(
      env,
      'maintenance_menus',
      { tenant_id: `eq.${tenantId}` },
      {
        select: 'labor_master_id,duration_days_min,duration_days_max,detailed_description,hero_image_url,sort_order',
        order: 'sort_order.asc',
        limit: 100,
      },
    ),
    loadAllLabor(env),
  ]);
  const laborById = new Map<string, LaborRow>(labors.map((l) => [l.id, l]));
  const menus: OverhaulMenu[] = [];
  for (const row of menuRows) {
    const labor = laborById.get(row.labor_master_id);
    // labor_master が archived 等で消えていれば skip (顧客に出せない)。
    if (!labor) continue;
    menus.push({
      laborId: labor.id,
      code: labor.code,
      name: labor.name,
      price: labor.price,
      priceMax: labor.price_max,
      priceOpenEnded: labor.price_open_ended,
      durationDaysMin: row.duration_days_min,
      durationDaysMax: row.duration_days_max,
      detailedDescription: row.detailed_description,
      heroImageUrl: row.hero_image_url,
      sortOrder: row.sort_order,
    });
  }
  return menus;
}

/**
 * 違いマトリクス素材: メニュー別に「含まれる機能 / オプション機能」を組む。
 * maintenance_menu_features を全件取り、feature_id → 機能名、labor_master_id でグルーピングする。
 */
export async function buildOverhaulMatrix(env: TrycleRepoEnv): Promise<OverhaulMenuMatrix[]> {
  const tenantId = getTenantId(env);
  const menus = await listOverhaulMenus(env);
  if (menus.length === 0) return [];

  const [features, menuFeatures] = await Promise.all([
    supabaseSelect<MaintenanceFeatureRow>(
      env,
      'maintenance_features',
      { tenant_id: `eq.${tenantId}`, archived: 'eq.false' },
      { select: 'id,category,name,sort_order', order: 'sort_order.asc', limit: 500 },
    ),
    // menu_features は tenant_id 列を持たない (labor_master 経由で tenant 紐付け)。
    // labor_master_id を menus の id 集合で in フィルタして tenant 横断を防ぐ。
    fetchMenuFeatures(env, menus.map((m) => m.laborId)),
  ]);

  const featureNameById = new Map<string, string>(features.map((f) => [f.id, f.name]));
  const byMenu = new Map<string, MenuFeatureRow[]>();
  for (const mf of menuFeatures) {
    const list = byMenu.get(mf.labor_master_id) ?? [];
    list.push(mf);
    byMenu.set(mf.labor_master_id, list);
  }

  return menus.map((menu) => {
    const rows = (byMenu.get(menu.laborId) ?? [])
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order);
    const includedFeatures: string[] = [];
    const optionalFeatures: OverhaulOption[] = [];
    for (const row of rows) {
      const featureName = featureNameById.get(row.feature_id);
      if (!featureName) continue;
      if (row.option_price === null) {
        includedFeatures.push(featureName);
      } else {
        optionalFeatures.push({
          featureName,
          priceLabel: formatOptionPrice(row.option_price, row.option_price_open_ended),
        });
      }
    }
    return { menu, includedFeatures, optionalFeatures };
  });
}

/** menu_features を labor_master_id の in フィルタで取得する (tenant 横断防止)。 */
async function fetchMenuFeatures(
  env: TrycleRepoEnv,
  laborIds: ReadonlyArray<string>,
): Promise<MenuFeatureRow[]> {
  if (laborIds.length === 0) return [];
  // PostgREST in.(a,b,c) — id は uuid なので引用符不要。
  const inList = `in.(${laborIds.join(',')})`;
  return supabaseSelect<MenuFeatureRow>(
    env,
    'maintenance_menu_features',
    { labor_master_id: inList },
    {
      select: 'labor_master_id,feature_id,option_price,option_price_open_ended,notes,sort_order',
      order: 'sort_order.asc',
      limit: 2000,
    },
  );
}

/** オプション料金の表示用文言。0 円/null・open-ended・固定額を分ける。 */
function formatOptionPrice(optionPrice: number, openEnded: boolean): string {
  const yen = `¥${optionPrice.toLocaleString('ja-JP')}`;
  return openEnded ? `${yen}〜` : yen;
}
