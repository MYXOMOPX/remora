import type { AxisConfig } from './axes.js';
import type { SourceConfig } from './sources.js';

export type CoreConfig = { timeAxes: AxisConfig[]; evidenceSources?: SourceConfig[] };

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
  evidenceSources: [
    {
      name: 'chat_message',
      description: 'Сообщение из чата: text (обязательно), sender, sent_at.',
      schema: {
        type: 'object',
        properties: { text: { type: 'string' }, sender: { type: 'string' }, sent_at: { type: 'string' } },
        required: ['text'],
      },
      keep: ['text', 'sender', 'sent_at'],
    },
  ],
};

export const configSchema = {
  type: 'object',
  properties: { timeAxes: { type: 'array' }, evidenceSources: { type: 'array' } },
  required: ['timeAxes'],
  additionalProperties: false,
};
