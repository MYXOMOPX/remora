import type { AxisConfig } from './axes.js';

export type CoreConfig = { timeAxes: AxisConfig[] };

export const defaultConfig: CoreConfig = {
  timeAxes: [
    {
      name: 'game_day',
      kind: 'integer',
      description: 'Игровые сутки: целое число, номер дня от начала игры (например, 292).',
    },
    {
      name: 'real',
      kind: 'datetime',
      unit: 'seconds',
      description:
        'Реальное время: строка ISO-8601 с часовым поясом (Z или смещение), например 2026-10-01T00:00:00Z.',
    },
    {
      name: 'story',
      kind: 'packed',
      components: [
        { name: 'tome', max: 999 },
        { name: 'chapter', max: 999 },
        { name: 'scene', max: 999 },
      ],
      description:
        'Сюжетное время: объект с компонентами tome (том), chapter (глава), scene (сцена); ' +
        'старший компонент первым. Обязателен только tome, остальные по умолчанию 0.',
      example: { tome: 10, chapter: 5 },
    },
  ],
};

export const configSchema = {
  type: 'object',
  properties: { timeAxes: { type: 'array' } },
  required: ['timeAxes'],
  additionalProperties: false,
};
