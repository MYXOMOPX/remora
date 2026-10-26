import { RemoraError, type TimeAxisDef } from '@remora/sdk';

export type AxisConfig = {
  name: string;
  description?: string;
  /** Пример значения для LLM; если не задан, выводится автоматически. */
  example?: unknown;
} & (
  | { kind: 'integer' }
  | { kind: 'datetime'; unit: 'seconds' | 'milliseconds' }
  | { kind: 'packed'; components: { name: string; max: number }[] }
);

const DEFAULT_INTEGER_DESCRIPTION =
  'Целочисленная шкала времени: значение — целое число (например, номер игрового дня).';
const DEFAULT_DATETIME_DESCRIPTION =
  'Календарная шкала времени: значение — строка ISO-8601 с часовым поясом (Z или смещение), например 2026-01-01T00:00:00Z.';

const ISO_WITH_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** Calendar/clock ranges that Date.parse would otherwise silently roll over. */
function isValidIso(value: string): boolean {
  const m = ISO_WITH_ZONE.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second, offH, offM] = [1, 2, 3, 4, 5, 6, 8, 9].map((i) =>
    m[i] === undefined ? 0 : Number(m[i]),
  ) as [number, number, number, number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day <= dim && hour <= 23 && minute <= 59 && second <= 59 && offH <= 23 && offM <= 59;
}

function invalid(axis: string, reason: string): RemoraError {
  return new RemoraError('invalid_time', `Недопустимое значение для шкалы «${axis}»: ${reason}`, { axis, reason });
}

function buildInteger(cfg: AxisConfig & { kind: 'integer' }): TimeAxisDef {
  return {
    name: cfg.name,
    description: cfg.description ?? DEFAULT_INTEGER_DESCRIPTION,
    valueSchema: { type: 'integer' },
    example: cfg.example ?? 1,
    encode(value) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw invalid(cfg.name, 'ожидается целое число');
      return BigInt(value);
    },
    decode: (n) => Number(n),
  };
}

function buildDatetime(cfg: AxisConfig & { kind: 'datetime' }): TimeAxisDef {
  if (cfg.unit !== 'seconds' && cfg.unit !== 'milliseconds') {
    throw new RemoraError('invalid_config', `Шкала «${cfg.name}»: unit должен быть seconds или milliseconds`, {
      axis: cfg.name, reason: 'bad unit',
    });
  }
  const factor = cfg.unit === 'seconds' ? 1000n : 1n;
  return {
    name: cfg.name,
    description: cfg.description ?? DEFAULT_DATETIME_DESCRIPTION,
    valueSchema: { type: 'string', format: 'date-time' },
    example: cfg.example ?? '2026-01-01T00:00:00Z',
    encode(value) {
      if (typeof value !== 'string' || !ISO_WITH_ZONE.test(value)) {
        throw invalid(cfg.name, 'ожидается строка ISO-8601 с часовым поясом (Z или смещение)');
      }
      if (!isValidIso(value)) throw invalid(cfg.name, 'несуществующая дата или время');
      const ms = Date.parse(value);
      if (Number.isNaN(ms)) throw invalid(cfg.name, 'некорректная дата');
      const big = BigInt(ms);
      // floor-деление, чтобы порядок сохранялся и для дат до эпохи
      return big >= 0n ? big / factor : -((-big + factor - 1n) / factor);
    },
    decode(n) {
      const ms = Number(n * factor);
      const d = new Date(ms);
      if (Number.isNaN(d.getTime())) throw invalid(cfg.name, 'значение вне допустимого диапазона дат');
      return d.toISOString();
    },
  };
}

function buildPacked(cfg: AxisConfig & { kind: 'packed' }): TimeAxisDef {
  const comps = cfg.components;
  const bad = (reason: string) =>
    new RemoraError('invalid_config', `Шкала «${cfg.name}»: ${reason}`, { axis: cfg.name, reason });
  if (!Array.isArray(comps)) throw bad('components должен быть массивом');
  if (comps.length === 0) throw bad('нужен хотя бы один компонент');
  const seen = new Set<string>();
  for (const c of comps) {
    if (typeof c !== 'object' || c === null || typeof c.name !== 'string' || c.name === '') {
      throw bad('у компонента должно быть имя');
    }
    if (!Number.isSafeInteger(c.max) || c.max < 0) throw bad(`max компонента «${c.name}» должен быть целым числом >= 0`);
    if (seen.has(c.name)) throw bad(`повторяющееся имя компонента «${c.name}»`);
    seen.add(c.name);
  }
  const radices = comps.map((c) => BigInt(c.max) + 1n);
  const names = comps.map((c) => c.name);
  const total = radices.reduce((a, b) => a * b, 1n);
  // верхняя граница мгновенного события t+1 тоже должна помещаться в int8
  if (total > 2n ** 63n - 1n) throw bad('произведение радиксов не помещается в int8 (bigint)');
  const first = names[0]!;
  const listing = comps.map((c) => `${c.name} (0..${c.max})`).join(', ');
  const description =
    cfg.description ??
    `Составная шкала времени: значение — объект с компонентами ${listing}; старший компонент первым. ` +
      `Обязателен только «${first}», остальные по умолчанию 0.`;
  const example =
    cfg.example ?? Object.fromEntries(names.slice(0, 2).map((n) => [n, 1]));

  return {
    name: cfg.name,
    description,
    valueSchema: {
      type: 'object',
      properties: Object.fromEntries(
        comps.map((c) => [c.name, { type: 'integer', minimum: 0, maximum: c.max }]),
      ),
      required: [first],
      additionalProperties: false,
    },
    example,
    encode(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw invalid(cfg.name, 'ожидается объект с компонентами');
      }
      const obj = value as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (!names.includes(key)) throw invalid(cfg.name, `неизвестный компонент «${key}»`);
      }
      if (obj[first] == null) throw invalid(cfg.name, `обязателен компонент «${first}»`);
      let acc = 0n;
      comps.forEach((c, i) => {
        const v = obj[c.name] === undefined ? 0 : obj[c.name];
        if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > c.max) {
          throw invalid(cfg.name, `компонент «${c.name}» должен быть целым числом от 0 до ${c.max}`);
        }
        acc = acc * radices[i]! + BigInt(v);
      });
      return acc;
    },
    decode(n) {
      if (n < 0n || n >= total) throw invalid(cfg.name, 'значение вне диапазона шкалы');
      const out: Record<string, number> = {};
      let rest = n;
      for (let i = comps.length - 1; i >= 0; i--) {
        out[comps[i]!.name] = Number(rest % radices[i]!);
        rest /= radices[i]!;
      }
      // порядок ключей: старший компонент первым
      return Object.fromEntries(names.map((k) => [k, out[k]]));
    },
  };
}

export function buildAxis(cfg: AxisConfig): TimeAxisDef {
  switch (cfg.kind) {
    case 'integer': return buildInteger(cfg);
    case 'datetime': return buildDatetime(cfg);
    case 'packed': return buildPacked(cfg);
    default: {
      const k = (cfg as { kind?: unknown } | null)?.kind;
      throw new RemoraError('invalid_config', `Неизвестный вид шкалы: ${String(k)}`, {
        axis: (cfg as { name?: unknown } | null)?.name, reason: 'unknown kind',
      });
    }
  }
}
