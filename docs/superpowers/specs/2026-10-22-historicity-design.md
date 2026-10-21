# Историчность фактов: дизайн v1

Дата: 2026-10-22
Статус: черновик, ждёт ревью

## 1. Цель

Хранить факты о сущностях (свойства и связи) с историей изменений на нескольких шкалах времени одновременно: реальное время, игровые дни, сюжетные главы и т.д. Факт может быть валиден на одной шкале, на нескольких или ни на одной.

Требования:
- ответ на вопрос «какое значение было / какие связи были на момент T по шкале X»;
- обходы графа на 5–6 шагов с фильтром по времени на каждом шаге;
- запрещённые состояния (два значения одного одноместного свойства одновременно) не записываются;
- сырые данные и evidence сохраняются отдельно от фактов;
- новая шкала времени и новый предикат добавляются без миграций схемы.

Вне рамок v1: свободные (неструктурированные) данные сверх `evidence_log`, дедупликация предикатов силами системы, LLM внутри системы.

## 2. Компоненты

Одна база PostgreSQL с расширениями `age` (граф) и `btree_gist` (EXCLUDE по скалярным типам). Одна транзакция на запись, без синхронизации двух хранилищ.

- **Граф `remora`** (AGE): сущности и связи, обходы.
- **Таблицы PostgreSQL**: словари, свойства, журнал evidence.

## 3. Сущности

```sql
CREATE TABLE entity (
  entity_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key       text NOT NULL UNIQUE          -- внешний идентификатор
);
```

Все внутренние ссылки — `bigint`. Текст используется только в `key`.

В графе сущность — вершина метки `Entity` со свойством `entity_id`.

## 4. Словари

Два словаря, потому что свойство и связь — разные сущности:

```sql
CREATE TABLE relation_type (
  id          smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  description text NOT NULL,              -- для LLM: когда использовать
  direction   text NOT NULL CHECK (direction IN ('directed', 'symmetric')),
  created_by  text NOT NULL               -- 'plugin' | 'llm'
);

CREATE TABLE property_type (
  id          smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  description text NOT NULL,
  value_type  text NOT NULL CHECK (value_type IN ('number', 'text', 'date', 'bool', 'json')),
  created_by  text NOT NULL
);
```

Ограничение: имена не должны совпадать между словарями. Проверяется на уровне API создания (см. раздел 9).

## 5. Шкалы времени

```sql
CREATE TABLE time_axis (
  id     smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name   text NOT NULL UNIQUE,            -- 'real', 'game_day', 'story'
  plugin text NOT NULL                    -- владелец правила кодирования
);
```

Правило кодирования (encoding) — в манифесте плагина, не в БД. Требование к нему: сохранять порядок, то есть `A < B` на шкале ⇔ `encode(A) < encode(B)`. Encoding не меняется после записи данных; изменение правила — это новая шкала с новым `id`.

Примеры:
- `real`: секунды от epoch;
- `game_day`: номер дня как есть;
- `story`: `tome*10^6 + chapter*10^3 + scene`, разряды с запасом и проверкой при записи.

Понятие **`time_span`** — пара `(time_axis, интервал)`. В таблицах это два столбца: `time_axis` и `time_span`.

Открытые границы: `int8range` поддерживает бесконечные границы. Открытый конец хранится как `NULL` (`[a, )`), открытое начало — как `(, b]`. «Сейчас» — параметр запроса, в данных не хранится.

## 6. Свойства

```sql
CREATE TABLE property_version (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_id        bigint    NOT NULL REFERENCES entity(entity_id),
  property_type_id smallint  NOT NULL REFERENCES property_type(id),
  time_axis        smallint  NOT NULL REFERENCES time_axis(id),
  time_span        int8range NOT NULL,
  value            jsonb     NOT NULL,
  evidence_id      bigint,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  EXCLUDE USING gist (entity_id WITH =, property_type_id WITH =,
                      time_axis WITH =, time_span WITH &&)
);
```

Свойство — это значение, которое в один момент может быть только одно. EXCLUDE гарантирует это на уровне базы.

Закрытие интервала: старая строка получает верхнюю границу, новая строка вставляется. Строки не удаляются.

## 7. Связи (граф)

Метка рёбер `RELATION`. Одно ребро — одна шкала времени. Связь на нескольких шкалах хранится несколькими рёбрами с одним `fact_id`.

Свойства ребра:
- `relation_type_id` — ссылка на `relation_type`;
- `fact_id` — `bigint` из последовательности, идентификатор связи вне графа;
- `evidence_id` — ссылка на `evidence_log`;
- `time_axis` — `smallint`;
- `from`, `to` — границы интервала как числа; отсутствие свойства означает открытую границу.

Пример: `Bob --works_at--> Google` на шкале `game_day` с днями 292–306:

```
(Bob)-[RELATION {relation_type_id:1, fact_id:10, evidence_id:5,
                 time_axis:2, from:292, to:306}]->(Google)
```

Связи не имеют EXCLUDE: две связи одного типа одновременно допустимы.

Направление: `directed` хранится как есть; `symmetric` хранится одним ребром, и при чтении направление не учитывается.

## 8. Правило выбора: свойство или связь

- Если у сущности в один момент может быть больше одного значения — это **связь** (`relation_type`). Пример: `Bob --favorite_color--> Blue` и `Bob --favorite_color--> Green`. Цвета — сущности.
- Если в один момент одно значение — это **свойство** (`property_type`). Пример: `Carl.height = 186`.

Правило задаёт тот, кто моделирует предикат, а не база. Словарь выбирается при создании.

## 9. Создание типов (для LLM и плагинов)

Система не содержит LLM и не решает, являются ли два имени синонимами.

1. **Нормализация имени** при записи: нижний регистр, пробелы в `_`, без спецсимволов. Точная проверка.
2. **Поиск кандидатов**: `find_relation_types(query)` и `find_property_types(query)` через `pg_trgm` (триграммное сходство). Возвращают список с оценкой; решение за вызывающей стороной.
3. **Создание с подтверждением**: `create_relation_type(...)` / `create_property_type(...)` без `confirm_new = true` возвращают похожих кандидатов и ничего не создают. С `confirm_new = true` создают тип.
4. **Проверка кросс-словарей**: имя не должно совпадать с именем в другом словаре.

Описание (`description`) пишет тот, кто создаёт тип. Оно отдаётся LLM вместе со списком типов.

## 10. Операции чтения

Закрытый набор операций с параметрами. Своего языка запросов нет.

Примеры:
- `property_at(entity, property_type, time_axis, at)` — значение на момент;
- `property_history(entity, property_type, time_axis)` — история;
- `neighbors(entity, relation_type, time_axis, at, depth, include, order_by, limit)` — обход на `depth` шагов, фильтр по времени на каждом шаге, подтягивание свойств из `property_version`, сортировка, лимит.

Структура `neighbors` — JSON-объект с типизированными полями. Поля фиксированы. Запрос, не укладывающийся в них, — новая операция или несколько вызовов.

Внутри `neighbors` два шага: обход в AGE, затем присоединение `property_version` на тот же момент.

Cypher генерирует код сервера, LLM его не пишет. Условие на открытую границу в Cypher: `(r.from IS NULL OR r.from <= $at) AND (r.to IS NULL OR r.to >= $at)`.

## 11. Evidence

`evidence_log` — таблица только для добавления:

```sql
CREATE TABLE evidence_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_type text NOT NULL,
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

Факты ссылаются на `evidence_id`. Объём сохраняемых данных задаёт плагин источника.

## 12. Открытые риски (проверяются спайком до реализации)

1. **Отсечение ветвей в AGE.** Фильтр по свойствам рёбер должен применяться на каждом шаге, а не после развёртки всех путей. Если нет — вариант AGE не подходит для 5–6 шагов. Проверка через `EXPLAIN` на синтетическом графе.
2. **Индексы на свойствах рёбер** в AGE (expression-индексы на `agtype`).
3. **Закрытие интервала связи** через Cypher `SET` в одной транзакции с SQL.
4. **Хостинг**: доступность AGE у выбранного провайдера PostgreSQL.
5. **Поведение `LIMIT`** при переменной глубине.

Если риск 1 не подтверждается, рассматриваем вариант с Neo4j как проекцией (см. предыдущие обсуждения).

## 13. Следующие шаги

1. Спайк по рискам 1–5 на локальном PostgreSQL с AGE.
2. Ревью этой спецификации.
3. План реализации (отдельный документ, после одобрения спецификации).
