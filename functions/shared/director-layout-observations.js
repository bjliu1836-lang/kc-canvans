export const DIRECTOR_LAYOUT_OBSERVATION_FORMAT = "image-observations-v1";

export const DIRECTOR_LAYOUT_OBSERVATION_SYSTEM_PROMPT = [
  "你只负责从参考图提取可见的二维视觉事实，不负责生成三维布局。只返回一个 JSON 对象，不要 Markdown 或解释。",
  "按优先级识别：可见墙面/地面/开口，其次大型家具，再识别显著小物和人物；side 仅为 image_left、image_right、image_back、floor、unknown。按原图观察者左右，不根据房间习惯补全被遮挡或画外墙面；open/outdoor 只报实际可见面。",
  "每个墙地面和物品都给稳定且唯一的短 id、归一化 bbox [left,top,right,bottom]（0..1）、confidence（0..1）、visibility（visible/partly_occluded/occluded/uncertain）和 mainColor（必填：可辨时 #RRGGBB，无法判断时 null）。物品尽量给 semanticType，可选 category。",
  "先看可见靠背/背板等家具背面特征及主体延伸方向，再判断物件接触哪一面实际可见墙；不得把家具背面默认等同于画面后墙。明确可见背面特征时，可给 rearFeature={name,bbox} 和 bodyExtendsToward（image_left/image_right/image_up/image_down/unknown），这是二维画面方向，不代表世界前后或三维朝向；不明确就省略或 unknown。contactWallSide 用 image_left/image_right/image_back/unknown/none 表达墙面侧；只有唯一匹配的可见墙时才锚定。床头、椅背仅为示例，不表示特定房间规则。也兼容旧 againstSurfaceId。",
  "物品可给 supportId（承托它的物件）和 partOfId（其可见几何已包含在父物件中的部件）；没有直接图像证据就省略关系。可辨主色使用 mainColor 的 #RRGGBB。",
  "输出 shape: {\"spaceType\":\"enclosed|open|outdoor|unknown\",\"surfaces\":[{\"id\":\"...\",\"kind\":\"wall|floor\",\"side\":\"image_left|image_right|image_back|floor|unknown\",\"bbox\":[0,0,1,1],\"confidence\":0.9,\"visibility\":\"visible\",\"mainColor\":null}],\"items\":[{\"id\":\"...\",\"name\":\"...\",\"semanticType\":\"...\",\"bbox\":[0,0,1,1],\"confidence\":0.9,\"visibility\":\"visible\",\"mainColor\":null,\"contactWallSide\":\"image_right\"}],\"people\":[{\"id\":\"...\",\"name\":\"...\",\"bbox\":[0,0,1,1],\"confidence\":0.9,\"visibility\":\"visible\",\"posture\":\"stand|sit|crouch|kneel|lie|unknown\",\"facingDirection\":\"image_left|image_right|toward_camera|away_from_camera|unknown\",\"supportId\":\"supporting_item_id\",\"kneelVariant\":\"one-knee|two-knee|seiza\",\"handGesture\":\"prayer\"}]}。surfaces 最多8项，物品与墙地总数最多30项，人物最多8个。",
  "每个人物都必须输出 posture：stand（站）, sit（坐）, crouch（蹲）, kneel（跪）, lie（躺/卧）, unknown（看不清）；不确定时必须显式写 unknown，不可省略或按人物名字/场景身份猜测。每个人物都必须输出 facingDirection：依据可见身体/脸/肢体朝向给 image_left/image_right/toward_camera/away_from_camera；无法直接判断时写 unknown。它只表示原图中的水平朝向，toward_camera/away_from_camera 分别指朝向/背向拍摄相机，不要根据人物名字、场景常识或道具位置猜目标。仅 visibility=visible 且 posture=kneel、并能直接看清跪姿细节时输出 kneelVariant（one-knee/two-knee/seiza）；看不清细分则 posture=unknown，不输出 kneelVariant。仅 visibility=visible 且明确看到双手合十时输出 handGesture=prayer；其余省略，不能从跪姿或人物名称推断。supportId 只在画面明确显示人物由某个物件承托时填写，值必须是该 items[].id。姿态字段只描述二维可见证据，不输出三维关节角、骨骼控制或动作预设。",
  "可见人物放入 people 数组，不要把人物画成普通物件；只输出 bbox、置信度、可见性、明确姿态和可直接观察到的支撑关系。不要输出任何三维坐标、米制尺寸、朝向角、相机参数、推测的精确尺度或 assembly。模糊、遮挡或裁切内容降低 confidence 并标 partly_occluded/uncertain，不要猜。",
].join("\n");

const SURFACE_KEYS = ["id", "kind", "side", "bbox", "confidence", "visibility"];
const ITEM_KEYS = ["id", "name", "semanticType", "category", "bbox", "confidence", "visibility", "againstSurfaceId", "contactWallSide", "rearFeature", "bodyExtendsToward", "supportId", "partOfId"];
const PERSON_KEYS = ["id", "name", "bbox", "confidence", "visibility", "posture", "facingDirection", "kneelVariant", "handGesture", "supportId"];

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pick(source, keys) {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function normalizedColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : undefined;
}

function validColorInput(value) {
  if (!isRecord(value)) return false;
  const appearance = isRecord(value.appearance) ? value.appearance : undefined;
  const candidates = [value.mainColor, value.color, appearance?.color].filter((item) => item !== undefined);
  return candidates.every((item) => item === null || normalizedColor(item) !== undefined);
}

function colorFromInput(value) {
  if (!isRecord(value)) return undefined;
  const appearance = isRecord(value.appearance) ? value.appearance : undefined;
  return normalizedColor(value.mainColor) ?? normalizedColor(value.color) ?? normalizedColor(appearance?.color);
}

function boundedRearFeature(value) {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim() || value.name.length > 80 || !validBox(value.bbox)) return undefined;
  return { name: value.name.trim(), bbox: value.bbox };
}

function validBox(value) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((part) => typeof part === "number" && Number.isFinite(part))) return false;
  const [left, top, right, bottom] = value;
  return left >= 0 && top >= 0 && right <= 1 && bottom <= 1 && right > left && bottom > top;
}

function validBase(value) {
  return typeof value.id === "string" && value.id.trim().length > 0 && value.id.length <= 48
    && validBox(value.bbox) && typeof value.confidence === "number" && Number.isFinite(value.confidence)
    && value.confidence >= 0 && value.confidence <= 1;
}

function validOptionalObservationFields(value, relationshipKeys) {
  const validVisibility = value.visibility === undefined
    || ["visible", "partly_occluded", "occluded", "uncertain"].includes(value.visibility);
  const validColor = validColorInput(value);
  const validRelationships = relationshipKeys.every((key) => value[key] === undefined
    || (typeof value[key] === "string" && value[key].trim().length > 0 && value[key].length <= 48));
  return validVisibility && validColor && validRelationships;
}

const valueType = (value) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

/** Return only bounded keys, JSON types, and array lengths; never return model values. */
export function summarizeDirectorLayoutObservationOutput(text) {
  const source = String(text || "");
  const stripped = source.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed;
  try { parsed = JSON.parse(stripped); }
  catch { return { outputBytes: source.length, json: "invalid" }; }
  if (!isRecord(parsed)) return { outputBytes: source.length, rootType: valueType(parsed) };
  const allowed = {
    $: ["spaceType", "surfaces", "items", "people"],
    surfaces: ["id", "kind", "side", "bbox", "confidence", "visibility", "mainColor", "color", "appearance"],
    items: ["id", "name", "semanticType", "category", "bbox", "confidence", "visibility", "mainColor", "color", "appearance", "againstSurfaceId", "contactWallSide", "rearFeature", "bodyExtendsToward", "supportId", "partOfId"],
    people: ["id", "name", "bbox", "confidence", "visibility", "posture", "facingDirection", "kneelVariant", "handGesture", "supportId"],
  };
  const summary = {
    outputBytes: source.length,
    rootKeys: Object.keys(parsed).filter((key) => allowed.$.includes(key)),
    unknownRootKeyCount: Math.max(0, Object.keys(parsed).length - Object.keys(parsed).filter((key) => allowed.$.includes(key)).length),
    rootTypes: {},
  };
  for (const key of summary.rootKeys) {
    const value = parsed[key];
    summary.rootTypes[key] = valueType(value);
    if (Array.isArray(value)) {
      summary[`${key}Length`] = value.length;
      const knownKeys = allowed[key] ?? [];
      summary[`${key}Items`] = value.slice(0, 32).map((item) => isRecord(item)
        ? {
          keys: Object.keys(item).filter((itemKey) => knownKeys.includes(itemKey)),
          types: Object.fromEntries(Object.keys(item).filter((itemKey) => knownKeys.includes(itemKey)).map((itemKey) => [itemKey, valueType(item[itemKey])])),
          unknownKeyCount: Math.max(0, Object.keys(item).length - Object.keys(item).filter((itemKey) => knownKeys.includes(itemKey)).length),
          ...(isRecord(item.appearance) ? { appearance: { keys: Object.keys(item.appearance).filter((appearanceKey) => appearanceKey === "color"), types: Object.fromEntries(Object.keys(item.appearance).filter((appearanceKey) => appearanceKey === "color").map((appearanceKey) => [appearanceKey, valueType(item.appearance[appearanceKey])])) } } : {}),
        }
        : { type: valueType(item) });
    }
  }
  return summary;
}

/** Summarize the provider's OpenAI-style envelope without retaining content or provider values. */
export function summarizeDirectorLayoutProviderEnvelope(value) {
  if (!isRecord(value)) return { rootType: valueType(value) };
  const summary = { rootKeys: Object.keys(value).filter((key) => ["id", "model", "choices", "usage", "error"].includes(key)), rootTypes: {} };
  for (const key of summary.rootKeys) summary.rootTypes[key] = valueType(value[key]);
  if (Array.isArray(value.choices)) {
    summary.choicesLength = value.choices.length;
    summary.choices = value.choices.slice(0, 4).map((choice) => {
      if (!isRecord(choice)) return { type: valueType(choice) };
      const result = { keys: Object.keys(choice).filter((key) => ["index", "message", "finish_reason"].includes(key)), types: {} };
      for (const key of result.keys) result.types[key] = valueType(choice[key]);
      if (isRecord(choice.message)) {
        result.message = {
          keys: Object.keys(choice.message).filter((key) => ["role", "content"].includes(key)),
          types: Object.fromEntries(Object.keys(choice.message).filter((key) => ["role", "content"].includes(key)).map((key) => [key, valueType(choice.message[key])])),
        };
        if (Array.isArray(choice.message.content)) result.contentPartTypes = choice.message.content.slice(0, 8).map(valueType);
      }
      return result;
    });
  }
  return summary;
}

function observationIssuePaths(parsed) {
  const issues = [];
  const baseFields = (value, path) => {
    if (!isRecord(value)) { issues.push(`${path}:expected_object`); return; }
    if (typeof value.id !== "string" || !value.id.trim() || value.id.length > 48) issues.push(`${path}.id:invalid`);
    if (!validBox(value.bbox)) issues.push(`${path}.bbox:invalid`);
    if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) issues.push(`${path}.confidence:invalid`);
  };
  if (!isRecord(parsed)) return ["$:expected_object"];
  if (!Array.isArray(parsed.surfaces)) issues.push("$.surfaces:expected_array");
  if (!Array.isArray(parsed.items)) issues.push("$.items:expected_array");
  if (parsed.people !== undefined && !Array.isArray(parsed.people)) issues.push("$.people:expected_array");
  if (Array.isArray(parsed.surfaces)) parsed.surfaces.forEach((value, index) => {
    const path = `$.surfaces[${index}]`; baseFields(value, path); if (!isRecord(value)) return;
    if (!["wall", "floor"].includes(value.kind)) issues.push(`${path}.kind:invalid`);
    if (!["image_left", "image_right", "image_back", "floor", "unknown"].includes(value.side) || (value.kind === "wall" && value.side === "floor")) issues.push(`${path}.side:invalid`);
    if (!validColorInput(value)) issues.push(`${path}.mainColor|color|appearance.color:invalid`);
    if (!validOptionalObservationFields(value, [])) issues.push(`${path}.optional_fields:invalid`);
  });
  if (Array.isArray(parsed.items)) parsed.items.forEach((value, index) => {
    const path = `$.items[${index}]`; baseFields(value, path); if (!isRecord(value)) return;
    if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 80) issues.push(`${path}.name:invalid`);
    if (value.semanticType !== undefined && (typeof value.semanticType !== "string" || value.semanticType.length > 48)) issues.push(`${path}.semanticType:invalid`);
    if (value.category !== undefined && !["ground", "wall", "door", "window", "table", "chair", "sofa", "cabinet", "pillar", "prop"].includes(value.category)) issues.push(`${path}.category:invalid`);
    if (!["visible", "partly_occluded", "occluded", "uncertain"].includes(value.visibility)) issues.push(`${path}.visibility:invalid`);
    if (!validOptionalObservationFields(value, ["againstSurfaceId", "supportId", "partOfId"])) issues.push(`${path}.optional_fields:invalid`);
    if (value.semanticType === undefined && value.category === undefined) issues.push(`${path}.semanticType|category:required`);
    if (value.contactWallSide !== undefined && !["image_left", "image_right", "image_back", "unknown", "none"].includes(value.contactWallSide)) issues.push(`${path}.contactWallSide:invalid`);
    if (value.bodyExtendsToward !== undefined && !["image_left", "image_right", "image_up", "image_down", "unknown"].includes(value.bodyExtendsToward)) issues.push(`${path}.bodyExtendsToward:invalid`);
    if (value.rearFeature !== undefined && !boundedRearFeature(value.rearFeature)) issues.push(`${path}.rearFeature:invalid`);
    if (!validColorInput(value)) issues.push(`${path}.mainColor|color|appearance.color:invalid`);
  });
  if (Array.isArray(parsed.people)) parsed.people.forEach((value, index) => {
    const path = `$.people[${index}]`; baseFields(value, path); if (!isRecord(value)) return;
    if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 80) issues.push(`${path}.name:invalid`);
    if (!["visible", "partly_occluded", "occluded", "uncertain"].includes(value.visibility)) issues.push(`${path}.visibility:invalid`);
    if (!["stand", "sit", "crouch", "kneel", "lie", "unknown"].includes(value.posture)) issues.push(`${path}.posture:required_or_invalid`);
    if (!["image_left", "image_right", "toward_camera", "away_from_camera", "unknown", "image_up", "image_down"].includes(value.facingDirection)) issues.push(`${path}.facingDirection:required_or_invalid`);
    if (value.kneelVariant !== undefined && (value.visibility !== "visible" || value.posture !== "kneel" || !["one-knee", "two-knee", "seiza"].includes(value.kneelVariant))) issues.push(`${path}.kneelVariant:invalid`);
    if (value.visibility === "visible" && value.posture === "kneel" && !["one-knee", "two-knee", "seiza"].includes(value.kneelVariant)) issues.push(`${path}.kneelVariant:required_for_visible_kneel`);
    if (value.handGesture !== undefined && (value.visibility !== "visible" || value.handGesture !== "prayer")) issues.push(`${path}.handGesture:invalid`);
    if (!validOptionalObservationFields(value, ["supportId"])) issues.push(`${path}.optional_fields:invalid`);
  });
  if (parsed.spaceType !== undefined && !["enclosed", "open", "outdoor", "unknown"].includes(parsed.spaceType)) issues.push("$.spaceType:invalid");
  return issues.slice(0, 40);
}

/** Parse and whitelist the bounded provider contract; detailed geometry validation stays in the frontend converter. */
export function parseDirectorLayoutObservation(text) {
  const source = String(text || "");
  if (source.length > 64 * 1024) {
    const error = new Error("视觉观察输出超出大小限制");
    error.kind = "model-schema";
    error.issues = ["图像观察输出超限"];
    throw error;
  }
  const stripped = source.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    const error = new Error("视觉观察 JSON 无效");
    error.kind = "model-json";
    error.issues = ["图像观察 JSON 无效"];
    throw error;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.surfaces) || !Array.isArray(parsed.items)
    || (parsed.people !== undefined && !Array.isArray(parsed.people))
    || parsed.surfaces.length > 8 || parsed.items.length > 30 || parsed.surfaces.length + parsed.items.length > 30) {
    const error = new Error("视觉观察结构无效");
    error.kind = "model-schema";
    error.issues = ["图像观察结构无效"];
    throw error;
  }
  if (parsed.spaceType !== undefined && !["enclosed", "open", "outdoor", "unknown"].includes(parsed.spaceType)) {
    const error = new Error("视觉观察空间类型无效");
    error.kind = "model-schema";
    error.issues = ["图像观察空间类型无效"];
    throw error;
  }
  if (!parsed.surfaces.every((surface) => isRecord(surface) && validBase(surface)
    && ["wall", "floor"].includes(surface.kind)
    && ["image_left", "image_right", "image_back", "floor", "unknown"].includes(surface.side)
    && !(surface.kind === "wall" && surface.side === "floor")
    && validOptionalObservationFields(surface, []))
    || !parsed.items.every((item) => isRecord(item) && validBase(item)
      && typeof item.name === "string" && item.name.trim().length > 0 && item.name.length <= 80
      && (item.semanticType === undefined || (typeof item.semanticType === "string" && item.semanticType.length <= 48))
      && (item.category === undefined || ["ground", "wall", "door", "window", "table", "chair", "sofa", "cabinet", "pillar", "prop"].includes(item.category))
      && ["visible", "partly_occluded", "occluded", "uncertain"].includes(item.visibility)
      && validOptionalObservationFields(item, ["againstSurfaceId", "supportId", "partOfId"])
      && (item.contactWallSide === undefined || ["image_left", "image_right", "image_back", "unknown", "none"].includes(item.contactWallSide))
      && (item.bodyExtendsToward === undefined || ["image_left", "image_right", "image_up", "image_down", "unknown"].includes(item.bodyExtendsToward))
      && (item.rearFeature === undefined || boundedRearFeature(item.rearFeature) !== undefined)
      && (item.semanticType !== undefined || item.category !== undefined))
    || (parsed.people?.length ?? 0) > 8
    || !(parsed.people ?? []).every((person) => isRecord(person) && validBase(person)
      && typeof person.name === "string" && person.name.trim().length > 0 && person.name.length <= 80
      && ["visible", "partly_occluded", "occluded", "uncertain"].includes(person.visibility)
      && ["stand", "sit", "crouch", "kneel", "lie", "unknown"].includes(person.posture)
      && ["image_left", "image_right", "toward_camera", "away_from_camera", "unknown", "image_up", "image_down"].includes(person.facingDirection)
      && (person.kneelVariant === undefined || (person.visibility === "visible" && person.posture === "kneel" && ["one-knee", "two-knee", "seiza"].includes(person.kneelVariant)))
      && (person.visibility !== "visible" || person.posture !== "kneel" || ["one-knee", "two-knee", "seiza"].includes(person.kneelVariant))
      && (person.handGesture === undefined || (person.visibility === "visible" && person.handGesture === "prayer"))
      && validOptionalObservationFields(person, ["supportId"]))) {
    const error = new Error("视觉观察对象无效");
    error.kind = "model-schema";
    error.issues = ["图像观察对象无效"];
    error.issuePaths = observationIssuePaths(parsed);
    throw error;
  }
  const ids = [...parsed.surfaces, ...parsed.items, ...(parsed.people ?? [])].map((entry) => entry.id.trim());
  if (new Set(ids).size !== ids.length) {
    const error = new Error("视觉观察 id 重复");
    error.kind = "model-schema";
    error.issues = ["图像观察 id 重复"];
    throw error;
  }
  return {
    ...(parsed.spaceType ? { spaceType: parsed.spaceType } : {}),
    surfaces: parsed.surfaces.map((surface) => {
      const color = colorFromInput(surface);
      return { ...pick(surface, SURFACE_KEYS), ...(color ? { mainColor: color } : (surface.mainColor === null || surface.color === null || (isRecord(surface.appearance) && surface.appearance.color === null) ? { mainColor: null } : {})) };
    }),
    items: parsed.items.map((item) => {
      const color = colorFromInput(item);
      const rearFeature = boundedRearFeature(item.rearFeature);
      return {
        ...pick(item, ITEM_KEYS),
        ...(color ? { mainColor: color } : (item.mainColor === null || item.color === null || (isRecord(item.appearance) && item.appearance.color === null) ? { mainColor: null } : {})),
        ...(rearFeature ? { rearFeature } : {}),
      };
    }),
    ...(Array.isArray(parsed.people) ? { people: parsed.people.map((person) => pick(person, PERSON_KEYS)) } : {}),
  };
}
