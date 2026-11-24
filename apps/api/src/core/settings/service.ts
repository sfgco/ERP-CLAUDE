import { SETTING_DEFINITIONS, type SettingKey, type SettingValue } from '@eayni/shared';
import { badRequest } from '../http/errors';
import type { Actor } from '../http/context';
import { recordAudit } from '../audit/service';
import { Setting } from './model';

const cache = new Map<string, { value: unknown; at: number }>();
const TTL_MS = 10_000;

export function clearSettingsCache(): void {
  cache.clear();
}

/** Current value of a setting: stored override, else the registry default. */
export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as SettingValue<K>;
  const doc = await Setting.findOne({ key }).lean();
  const def = SETTING_DEFINITIONS[key];
  const value = doc ? (doc.value as SettingValue<K>) : (def.default as SettingValue<K>);
  cache.set(key, { value, at: Date.now() });
  return value;
}

/**
 * Value plus whether it is still provisional («مؤقت حتى اعتماد الموارد البشرية», DECISIONS §21): a definition marked
 * `provisional` stays so until an admin confirms it, whatever value is stored.
 */
export async function getSettingMeta<K extends SettingKey>(
  key: K,
): Promise<{ value: SettingValue<K>; provisional: boolean; confirmedAt?: Date | null }> {
  const def = SETTING_DEFINITIONS[key];
  const doc = await Setting.findOne({ key }).lean();
  const value = doc && doc.value !== undefined ? (doc.value as SettingValue<K>) : (def.default as SettingValue<K>);
  return { value, provisional: !!def.provisional && !doc?.confirmedAt, confirmedAt: doc?.confirmedAt ?? null };
}

/** The admin confirms a provisional setting (keeps the current value); audited. */
export async function confirmSetting(key: SettingKey, actor: Actor): Promise<void> {
  const def = SETTING_DEFINITIONS[key];
  if (!def) throw badRequest(`إعداد غير معروف: ${key}`);
  const existing = await Setting.findOne({ key }).lean();
  await Setting.updateOne(
    { key },
    {
      $set: { confirmedAt: new Date(), confirmedBy: actor.userId ?? actor.email },
      ...(existing ? {} : { $setOnInsert: { value: def.default } }),
    },
    { upsert: true },
  );
  cache.delete(key);
  await recordAudit(actor, { action: 'approve', resource: 'settings', resourceId: key, meta: { confirmed: true } });
}

export async function setSetting<K extends SettingKey>(
  key: K,
  raw: unknown,
  actor: Actor,
): Promise<SettingValue<K>> {
  const def = SETTING_DEFINITIONS[key];
  if (!def) throw badRequest(`إعداد غير معروف: ${key}`);
  const parsed = def.schema.safeParse(raw);
  if (!parsed.success) throw badRequest('قيمة غير صالحة للإعداد', parsed.error.issues);
  const before = await Setting.findOne({ key }).lean();
  const doc = await Setting.findOneAndUpdate(
    { key },
    { $set: { value: parsed.data, updatedBy: actor.userId ?? actor.email } },
    { upsert: true, new: true },
  ).lean();
  cache.delete(key);
  await recordAudit(actor, {
    action: before ? 'update' : 'create',
    resource: 'settings',
    resourceId: key,
    before: before ? { value: before.value } : undefined,
    after: { value: doc?.value },
  });
  return doc!.value as SettingValue<K>;
}

export async function listSettings(): Promise<
  {
    key: string;
    labelAr: string;
    descriptionAr?: string;
    group: string;
    value: unknown;
    default: unknown;
    isDefault: boolean;
    provisional: boolean;
    confirmedAt?: Date | null;
  }[]
> {
  const stored = await Setting.find().lean();
  const byKey = new Map(stored.map((s) => [s.key, s]));
  return (Object.keys(SETTING_DEFINITIONS) as SettingKey[]).map((key) => {
    const def = SETTING_DEFINITIONS[key];
    const doc = byKey.get(key);
    const has = !!doc && doc.value !== undefined;
    return {
      key,
      labelAr: def.labelAr,
      descriptionAr: def.descriptionAr,
      group: def.group,
      value: has ? doc!.value : def.default,
      default: def.default,
      isDefault: !has,
      provisional: !!def.provisional && !doc?.confirmedAt,
      confirmedAt: doc?.confirmedAt ?? null,
    };
  });
}
