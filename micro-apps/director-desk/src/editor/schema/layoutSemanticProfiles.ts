import type { DirectorLayoutCategory } from "./directorProject";

export interface LayoutSemanticProfile {
  canonicalType: string;
  category: DirectorLayoutCategory;
  compatibleGeometryCategories?: readonly DirectorLayoutCategory[];
}

export function isLayoutSemanticCategoryCompatible(profile: LayoutSemanticProfile, category: DirectorLayoutCategory) {
  return profile.category === category || Boolean(profile.compatibleGeometryCategories?.includes(category));
}

const EXACT_PROFILES: Record<string, LayoutSemanticProfile> = {
  bed: { canonicalType: "bed", category: "sofa" },
  bookshelf: { canonicalType: "bookshelf", category: "cabinet" },
  cabinet: { canonicalType: "cabinet", category: "cabinet" },
  curtain: { canonicalType: "curtain", category: "window" },
  window: { canonicalType: "window", category: "window" },
  door: { canonicalType: "door", category: "door" },
  desk: { canonicalType: "desk", category: "table" },
  table: { canonicalType: "table", category: "table" },
  chair: { canonicalType: "chair", category: "chair" },
  sofa: { canonicalType: "sofa", category: "sofa" },
  floor: { canonicalType: "floor", category: "ground" },
  wall: { canonicalType: "wall", category: "wall" },
  pillar: { canonicalType: "pillar", category: "pillar" },
  buddha_statue: { canonicalType: "sculpture", category: "prop" },
  statue: { canonicalType: "sculpture", category: "prop" },
  sculpture: { canonicalType: "sculpture", category: "prop" },
  vase: { canonicalType: "container", category: "prop" },
  flower_vase: { canonicalType: "container", category: "prop" },
  candle_holder: { canonicalType: "candlestick", category: "prop" },
  candlestick: { canonicalType: "candlestick", category: "prop" },
  candle_stick: { canonicalType: "candlestick", category: "prop" },
  incense_burner: { canonicalType: "container", category: "prop" },
  censer: { canonicalType: "container", category: "prop" },
  lantern: { canonicalType: "lantern", category: "prop" },
  urn: { canonicalType: "container", category: "prop" },
  container: { canonicalType: "container", category: "prop" },
  altar_table: { canonicalType: "table", category: "table" },
  small_table: { canonicalType: "table", category: "table" },
  side_table: { canonicalType: "table", category: "table" },
  dining_table: { canonicalType: "table", category: "table" },
  garden_table: { canonicalType: "table", category: "table" },
  bedside_table: { canonicalType: "table", category: "table" },
  nightstand: { canonicalType: "nightstand", category: "table", compatibleGeometryCategories: ["cabinet"] },
  table_lamp: { canonicalType: "table_lamp", category: "prop" },
  desk_lamp: { canonicalType: "table_lamp", category: "prop" },
  floor_lamp: { canonicalType: "table_lamp", category: "prop" },
  wall_lamp: { canonicalType: "table_lamp", category: "prop" },
  hanging_lamp: { canonicalType: "ceiling_lamp", category: "prop" },
  lamp: { canonicalType: "table_lamp", category: "prop" },
  plant: { canonicalType: "plant", category: "prop" },
  flower: { canonicalType: "plant", category: "prop" },
  potted_plant: { canonicalType: "plant", category: "prop" },
  pillow: { canonicalType: "pillow", category: "prop" },
  cushion: { canonicalType: "pillow", category: "prop" },
  figurine: { canonicalType: "sculpture", category: "prop" },
  bottle: { canonicalType: "container", category: "prop" },
  jar: { canonicalType: "container", category: "prop" },
  tablecloth: { canonicalType: "tablecloth", category: "prop" },
  blanket: { canonicalType: "blanket", category: "prop" },
  throw_blanket: { canonicalType: "blanket", category: "prop" },
};

/** Resolves compound names by entity, preserving lamp/textile meanings before table tokens. */
export function resolveLayoutSemanticProfile(semanticType?: string, name?: string): LayoutSemanticProfile | undefined {
  const semantic = (semanticType ?? "").toLowerCase().trim().replace(/[\s-]+/g, "_");
  const named = (name ?? "").toLowerCase().trim();
  // A supplied semantic label is the entity identity. Names often include a
  // parent or scene context (for example, "tea set on coffee table"), so they
  // may only serve as a fallback when no semantic label was supplied.
  const nameFallback = semantic.length === 0;
  if (EXACT_PROFILES[semantic]) return EXACT_PROFILES[semantic];
  if (/^(?:buddha|statue|sculpture)(?:_[a-z0-9]+)*$/.test(semantic) || (nameFallback && /佛像|雕像|塑像/.test(named))) return EXACT_PROFILES.sculpture;
  if (/^(?:[a-z0-9]+_)?vase(?:_[a-z0-9]+)*$/.test(semantic) || (nameFallback && /花瓶/.test(named))) return EXACT_PROFILES.container;
  if (/^(?:bottle|jar|container|pot)(?:_[a-z0-9]+)*$|瓶|罐|容器/.test(semantic) || (nameFallback && /花瓶|瓶|罐|容器/.test(named))) return EXACT_PROFILES.container;
  if (/^(?:plant|flower|potted_plant)(?:_[a-z0-9]+)*$|植物|花卉/.test(semantic) || (nameFallback && /植物|花卉|盆栽/.test(named))) return EXACT_PROFILES.plant;
  if (/^(?:pillow|cushion|seat_pad)(?:_[a-z0-9]+)*$|枕头|靠垫|坐垫/.test(semantic) || (nameFallback && /枕头|靠垫|坐垫/.test(named))) return EXACT_PROFILES.pillow;
  if (/^(?:figurine)(?:_[a-z0-9]+)*$|摆件|人像/.test(semantic) || (nameFallback && /摆件|人像/.test(named))) return EXACT_PROFILES.figurine;
  if (/^(?:candle_holder|candlestick|candle_stick)(?:_[a-z0-9]+)*$/.test(semantic) || (nameFallback && /烛台|蜡烛架/.test(named))) return EXACT_PROFILES.candle_holder;
  if (/^(?:incense_burner|censer)(?:_[a-z0-9]+)*$/.test(semantic) || (nameFallback && /香炉|香薰炉/.test(named))) return EXACT_PROFILES.container;
  if (/^urn(?:_[a-z0-9]+)*$/.test(semantic)) return EXACT_PROFILES.container;
  if (/^lantern(?:_[a-z0-9]+)*$/.test(semantic)) return EXACT_PROFILES.lantern;
  if (/(^|[_\s-])(tablecloth|table_cloth|cloth|blanket|throw|textile)([_\s-]|$)|桌布|毯|床单|被子/.test(semantic)
    || (nameFallback && /桌布|毯|床单|被子/.test(named))) return EXACT_PROFILES.tablecloth;
  if (/^(?:hanging|pendant|ceiling)_lamp(?:_[a-z0-9]+)*$|吊灯|悬挂灯/.test(semantic) || (nameFallback && /吊灯|悬挂灯/.test(named))) return EXACT_PROFILES.hanging_lamp;
  if (/^(?:(?:table|desk|floor|wall)_)?lamp(?:_[a-z0-9]+)*$|^(?:floor|ceiling)_lantern(?:_[a-z0-9]+)*$|台灯|落地灯/.test(semantic)
    || (nameFallback && /台灯|落地灯/.test(named))) return EXACT_PROFILES.lamp;
  if (/(^|[_\s-])([a-z0-9]+_)?table([_\s-]|$)|供桌|餐桌|书桌|桌子|茶几|小木几|边桌/.test(semantic)
    || (nameFallback && /供桌|餐桌|书桌|桌子|茶几|小木几|边桌/.test(named))) return EXACT_PROFILES.table;
  return undefined;
}
