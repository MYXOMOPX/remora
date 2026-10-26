# Историчность фактов: дизайн v1

Дата: 2026-10-25 (первая версия 2026-10-22)
Статус: черновик, ждёт ревью

## 1. Цель

Хранить факты о сущностях (свойства и связи) с историей изменений на нескольких шкалах времени одновременно: реальное время, игровые дни, сюжетные главы и т.д. Факт может быть валиден на одной шкале, на нескольких или быть безвременным.

Требования:
- ответ на вопрос «какое значение было / какие связи были на момент T по шкале X»;
- обходы по связям на 5–6 шагов с фильтром по времени на каждом шаге;
- сырые данные и evidence хранятся отдельно от фактов;
- новая шкала времени и новый тип свойства или связи добавляются без миграций схемы;
- один запрос может содержать много операций, выполняемых атомарно.

Вне рамок v1: связи между событиями; автоматическая политика хранения evidence по расписанию; дедупликация типов силами системы; LLM внутри системы; многопользовательскость (одна база).

## 2. Архитектура

Микросервис в Docker-контейнере поверх одной базы PostgreSQL с расширениями `btree_gist` (EXCLUDE по скалярным типам) и `pg_trgm` (триграммные индексы для текстового поиска; оценок сходства и поиска дублей не используется). Транспорт: HTTP и MCP; операции API становятся инструментами MCP один в один.

Авторизация в v1: секретный URL (`secret_url`) на сервис; один URL — одна база, ролей нет.

Граф как отдельное хранилище не используется. Связи — обычная таблица `relation`, обходы — цепочка JOIN или рекурсивный CTE (обоснование — раздел 14).

## 3. Сущности

```sql
CREATE TABLE entity (
  entity_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key       text NOT NULL UNIQUE          -- внешний идентификатор
);
CREATE INDEX entity_key_trgm ON entity USING gin (key gin_trgm_ops);   -- для find_entities
```

Все внутренние ссылки — `bigint`; текст используется только в `key`. Сущность создаётся явной операцией `create_entity`; использование неизвестного `key` в других операциях — ошибка.

## 4. Словари

```sql
CREATE TABLE relation_type (
  id          smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  description text NOT NULL,              -- для LLM: когда использовать
  directed    boolean NOT NULL            -- true: направленная, false: симметричная
);

CREATE TABLE property_type (
  id            smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  description   text NOT NULL,
  value_type    text NOT NULL CHECK (value_type IN ('number', 'text', 'date', 'bool', 'json')),
  single_valued boolean NOT NULL,         -- в один момент одно значение
  UNIQUE (id, single_valued)              -- цель составного FK (раздел 6)
);
```

Имена не должны совпадать между словарями; проверяется API создания (раздел 9). `single_valued` после создания типа не меняется (раздел 6).

## 5. Шкалы времени

```sql
CREATE TABLE time_axis (
  id     smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- начинается с 1
  name   text NOT NULL UNIQUE,            -- 'real', 'game_day', 'story'
  plugin_id    smallint NOT NULL REFERENCES plugin(id),   -- владелец правила кодирования (раздел 13)
  description  text  NOT NULL,            -- для LLM: что измеряет шкала и как писать значение
  value_schema jsonb NOT NULL,            -- JSON Schema входного значения, например объект {tome, chapter}
  example      jsonb NOT NULL             -- пример значения, который понимает плагин
);
```

`description`, `value_schema` и `example` плагин передаёт при регистрации шкалы; их возвращает `list_time_axes`. Пример для `story`: `value_schema = {"type":"object","properties":{"tome":{"type":"integer"},"chapter":{"type":"integer"},"scene":{"type":"integer"}},"required":["tome"]}`, `example = {"tome": 10, "chapter": 5}`. API проверяет входное значение времени по `value_schema` (ошибка `invalid_time`) и передаёт плагину, который кодирует его в число.

Правило кодирования (encoding) — в манифесте плагина, не в БД. Оно сохраняет порядок: `A < B` на шкале ⇔ `encode(A) < encode(B)`. Encoding не меняется после записи данных; изменение правила — новая шкала с новым `id`. На входе и выходе API время передаётся в единицах шкалы; кодирование в `int8` делает плагин.

Примеры:
- `real`: секунды от epoch;
- `game_day`: номер дня как есть;
- `story`: `tome*10^6 + chapter*10^3 + scene`; значения компонентов проверяются при записи (при множителе 10^3 тройка `(2, 1000, 0)` дала бы `3000000`, как `(3, 0, 0)`, поэтому верхние границы разрядов проверяются).

**Временная привязка факта** — пара `(time_axis, time_span)`:
- `time_span` — `int8range` с полуинтервалом `[from, to)`; обе границы опциональны (`NULL` = без ограничения);
- **безвременный факт**: оба поля `NULL`; такой факт считается актуальным при любом запросе времени.

Факт актуален на момент `t` шкалы `X`, если

```
time_axis IS NULL OR (time_axis = X AND from <= t AND t < to)   -- границы NULL означают «нет ограничения»
```

Значение, валидное на двух шкалах, — две строки (без общего идентификатора для свойств; `relation_id` для связей — раздел 7). «Сейчас» в данных не хранится: у каждой шкалы оно своё, его задаёт вызывающая сторона параметром `at`. Режима «только открытые факты» нет.

## 6. Свойства

```sql
CREATE TABLE property_version (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_id        bigint    NOT NULL REFERENCES entity(entity_id),
  property_type_id smallint  NOT NULL,
  single_valued    boolean   NOT NULL,     -- копия флага из property_type, заполняется триггером
  time_axis        smallint  REFERENCES time_axis(id),
  time_span        int8range,
  value            jsonb     NOT NULL,
  evidence_id      bigint    REFERENCES evidence_log(id),
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  retracted_at          timestamptz,     -- отозванная запись (раздел 6, «Отзыв»)
  retracted_evidence_id bigint REFERENCES evidence_log(id),
  CHECK ((time_axis IS NULL) = (time_span IS NULL)),
  FOREIGN KEY (property_type_id, single_valued)
    REFERENCES property_type (id, single_valued),
  EXCLUDE USING gist (
    entity_id WITH =,
    property_type_id WITH =,
    (COALESCE(time_axis, 0)) WITH =,
    (COALESCE(time_span, '(,)'::int8range)) WITH &&
  ) WHERE (single_valued AND retracted_at IS NULL)
);

CREATE FUNCTION property_version_fill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT single_valued INTO NEW.single_valued FROM property_type WHERE id = NEW.property_type_id;
  RETURN NEW;
END $$;
CREATE TRIGGER property_version_fill_t BEFORE INSERT ON property_version
  FOR EACH ROW EXECUTE FUNCTION property_version_fill();

-- текстовый поиск по значениям-строкам
CREATE INDEX property_version_text_trgm ON property_version
  USING gin ((value #>> '{}') gin_trgm_ops) WHERE jsonb_typeof(value) = 'string';
```

- Одна строка — одно значение на одной шкале (или безвременное).
- Для **многоместных** свойств (`single_valued = false`) в БД на одном промежутке может быть несколько значений.
- Для **одноместных** EXCLUDE запрещает пересечение интервалов. Копия `single_valued` в строке заполняется триггером из справочника, составной FK не даёт ей разойтись; пока у типа есть строки, флаг в словаре изменить нельзя.
- Проверено в спайке на этой схеме (PostgreSQL 18.6): пересечение на одной шкале отклоняется; тот же интервал на другой шкале проходит; два безвременных значения одноместного свойства отклоняются; многоместное свойство принимает два открытых значения; шкала без интервала отклоняется CHECK; «закрыть старую строку и вставить новую» в одной транзакции проходит; изменение флага при существующих строках отклоняется.
- Безвременное и временное значения одноместного свойства EXCLUDE не различает (разные ключи `COALESCE`), поэтому правило задаёт API: для одноместного свойства нельзя иметь одновременно безвременное и временные (неотозванные) значения; нарушение — ошибка `timeless_conflict`.
- Строки не удаляются, ошибочные записи отзываются (см. «Отзыв»). Условие `retracted_at IS NULL` в EXCLUDE в спайке не проверялось (раздел 15).

### Операции записи свойств

Каждая выполняется в рамках общего пакета (раздел 10). Примеры на шкале `game_day`.

Одноместное `job_title`:

| Вызов | Строки после |
|---|---|
| `replace_property(Bob, job_title, game_day, at=292, 'Junior')` | `[292,)` Junior |
| `replace_property(..., at=300, 'Senior')` | `[292,300)` Junior; `[300,)` Senior |
| `end_property(Bob, job_title, game_day, at=310)` | `[292,300)` Junior; `[300,310)` Senior |

Многоместное `nickname`:

| Вызов | Строки после |
|---|---|
| `add_property(Bob, nickname, game_day, from=292, 'Bobby')` | `[292,)` Bobby |
| `add_property(Bob, nickname, game_day, from=295, 'Rob')` | `[292,)` Bobby; `[295,)` Rob |

Правила:
- `replace_property` закрывает **все** открытые строки свойства на шкале (`to = at`) и вставляет новую (`from = at`); закрыть можно только моментом `at ≥ from` открытой строки;
- `add_property` на одноместном свойстве вставляет строку и упирается в EXCLUDE при пересечении; штатный путь замены — `replace_property`;
- `end_property` закрывает открытые строки и новой не создаёт;
- `replace_property` без `time` работает с безвременным значением: отзывает текущее безвременное значение и вставляет новое (истории интервалов у такого значения нет);
- значение проверяется на соответствие `value_type`.

### Отзыв

Строки не удаляются. Ошибочно записанный факт отзывается: в строке проставляется `retracted_at` (и, если задан, `retracted_evidence_id`). Отозванные строки не участвуют в EXCLUDE и по умолчанию не попадают в чтение; `property_history` и `relation_history` возвращают их при `include_retracted: true`. Исправление = отзыв неверной строки + вставка верной в одном пакете. Отозвать можно только по `id` строки (id возвращают операции чтения и записи).

## 7. Связи

```sql
CREATE TABLE relation (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  relation_id      bigint NOT NULL,        -- логическая связь; общий для строк по шкалам
  relation_type_id smallint NOT NULL REFERENCES relation_type(id),
  src              bigint NOT NULL REFERENCES entity(entity_id),
  dst              bigint NOT NULL REFERENCES entity(entity_id),
  time_axis        smallint REFERENCES time_axis(id),
  time_span        int8range,
  evidence_id      bigint REFERENCES evidence_log(id),
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  retracted_at          timestamptz,
  retracted_evidence_id bigint REFERENCES evidence_log(id),
  CHECK ((time_axis IS NULL) = (time_span IS NULL))
);
CREATE INDEX relation_src_idx ON relation (src, relation_type_id, time_axis);
CREATE INDEX relation_dst_idx ON relation (dst, relation_type_id, time_axis);
```

`relation_id` берётся из последовательности. Одна строка — одна шкала. Связь, валидная на двух шкалах, — две строки с общим `relation_id`. Безвременная связь — одна строка с `NULL` в `time_axis` и `time_span`.

Пример: Боб работает в Google на `game_day` с 292 по 306 и в реальном времени с 2026-10-01 по 2026-10-20:

```
relation_id=10  Bob → Google  works_at  game_day  [292,306)
relation_id=10  Bob → Google  works_at  real      [1790812800,1792540800)
```

- Ограничений уникальности нет: две связи одного типа одновременно допустимы.
- `directed = false`: строка одна, чтение учитывает обе стороны (`src = x OR dst = x`, для обхода — `UNION ALL` двух направлений).
- Обратное имя связи не хранится.

Операции:
- `add_relation` — создаёт строки на указанных шкалах с общим новым `relation_id`; ответ содержит `relation_id`;
- `end_relation` — закрывает `to` на шкале `axis` в момент `at`. Связь задаётся либо `relation_id`, либо селектором `{type, from, to}` (закрываются все неотозванные открытые связи этого типа между сущностями; если подходящих нет — ошибка `not_found`);
- `retract_relation` — отзывает все строки связи (или только строку шкалы `axis`); связь задаётся так же, как в `end_relation`. Отзыв строк связи не удаляет их.

Все чтения и `neighbors` исключают отозванные строки; `relation_history` возвращает их при `include_retracted: true`.

## 8. Свойство или связь

- Если в один момент может быть больше одного значения с собственной идентичностью (хобби, любимые цвета) — **связь** к сущности: `Bob --favorite_color--> Blue`, `Bob --favorite_color--> Green`.
- Если значение скалярное — **свойство**: `Carl.height = 186`; `single_valued` отмечает, что значение одно.

Правило применяет тот, кто создаёт тип.

## 9. Создание типов

Система не содержит LLM, не ищет дубли и не решает, являются ли два имени синонимами. Дедупликация целиком на стороне вызывающего.

1. **Нормализация имени** при записи: нижний регистр, пробелы в `_`, без спецсимволов.
2. **Поиск**: `find_relation_types(query)` и `find_property_types(query)` — поиск по вхождению слов запроса в имя и описание (`ILIKE`, без оценок сходства); `list_*` — полный список. Кандидатов и оценок система не вычисляет.
3. **Создание**: `create_relation_type(...)` / `create_property_type(...)` создаёт тип сразу. Ошибка `name_taken`, если нормализованное имя уже есть в любом словаре (кросс-словарная проверка).

## 10. API

Закрытый набор операций с типизированными JSON-параметрами. Языка запросов нет; LLM SQL не пишет.

### 10.1 Запись: `apply`

Один вызов — список операций. Выполняются по порядку в одной транзакции; каждая видит результат предыдущих. Любая ошибка откатывает весь пакет и возвращает индекс операции и типизированную причину. Одиночная операция — пакет из одной.

Локальные имена: операция может объявить `"as": "имя"`, дальше на результат ссылаются как `"$имя"`. Evidence необязателен; один `add_evidence` может стоять под любым числом фактов пакета. `evidence` — это `$имя` либо числовой id существующей записи.

```json
{"ops": [
  {"op": "add_evidence", "as": "e1", "source": "chat_message", "payload": {"msg": "..."}},
  {"op": "create_entity", "key": "carl"},
  {"op": "replace_property", "entity": "bob", "property": "job_title",
   "time": {"axis": "game_day", "at": 292}, "value": "Senior", "evidence": "$e1"},
  {"op": "add_relation", "type": "works_at", "from": "bob", "to": "google",
   "time": {"axis": "game_day", "from": 292}, "evidence": "$e1"}
]}
```

Операции записи:

| Операция | Назначение | Время |
|---|---|---|
| `add_evidence` | запись в `evidence_log` через плагин источника (`source`, `payload` по схеме, раздел 12) | — |
| `add_event`, `update_event`, `retract_event` | события (раздел 11) | `time[]` у `add_event` |
| `create_entity` | создаёт или возвращает существующую (идемпотентна) | — |
| `add_property` | значение; многоместные свойства | необязательно: `axis` + `from`/`to`; можно список (по строке на шкалу); без `time` — безвременное |
| `replace_property` | закрыть открытые и открыть новое | `axis` + `at` обязательны |
| `end_property` | закрыть открытые | `axis` + `at` обязательны |
| `add_relation` | связь | как у `add_property` |
| `end_relation` | закрыть связь по `relation_id` или селектору `{type, from, to}` | `axis` + `at` обязательны |
| `retract_property` | отозвать ошибочную запись по `id` | — |
| `retract_relation` | отозвать связь (все шкалы или одну) | — |
| `create_relation_type`, `create_property_type` | словари | — |

`end_property`, `end_relation`, `retract_*` принимают необязательный `evidence`.

### Форма ответа и ошибки

Успех: `{"ok": true, "results": [ ...результат каждой операции по порядку... ]}`. Результат операции записи содержит созданные или изменённые `id` строк, у `add_relation` — `relation_id`, у операций с `as` — ссылку.

Ошибка (весь пакет откатывается): `{"ok": false, "error": {"op_index": 2, "code": "unknown_entity", "message": "...", "details": {...}}}`.

Коды: `unknown_entity`, `unknown_type`, `unknown_axis`, `unknown_ref`, `value_type_mismatch`, `single_valued_conflict`, `timeless_conflict`, `invalid_time` (с причиной по `value_schema`), `not_found`, `name_taken`, `invalid_payload`, `unknown_source`, `too_many_paths`, `concurrent_update` (повторить пакет).

### Контракт

Сервис публикует JSON Schema для `apply`, `query`, ответов и ошибок (HTTP: `/schema`; MCP: схемы инструментов). Схемы — источник для документации и клиентов.

### 10.2 Чтение: `query`

Список read-операций, результаты возвращаются по порядку. Время задаётся необязательным параметром `when`:
- `{"axis": "game_day", "at": 300}` — актуальные на момент;
- `{"axis": "game_day", "during": [290, 310]}` — пересекающие промежуток;
- опущен — без фильтра по времени: все версии, каждая со своим `time`.

Безвременные факты попадают в ответ при любом `when`.

| Операция | Назначение |
|---|---|
| `get_entity(key)` | сущность |
| `find_entities(query, limit)` | поиск сущностей по вхождению слов запроса в `key` (без оценок сходства) |
| `property_at(entity, property, when)` | значения (список: у многоместных их несколько), каждое с `id` |
| `property_history(entity, property, [axis], [include_retracted])` | все версии, с интервалами и `id` |
| `relation_history(entity, [relation_types], [direction], [when], [include_retracted])` | все версии связей с `relation_id` |
| `neighbors(...)` | обход |
| `get_event`, `search_events`, `entity_events`, `list_event_roles` | события (раздел 11) |
| `list_evidence_sources`, `get_evidence` | evidence (раздел 12) |
| `list_relation_types`, `list_property_types`, `find_*_types`, `list_time_axes` | словари (шкалы — с `description`, `value_schema`, `example`) |

### 10.3 `neighbors`

Параметры: `entity`, `relation_types[]`, `direction` (`out` | `in` | `both`, для симметричных игнорируется), `depth` (1–6), `when`, `include[]` (свойства для подтягивания), `order_by` (`{property, dir}`), `limit` (по умолчанию 50, максимум 200), `paths` (bool, по умолчанию `false`). Пагинации нет: ответ содержит `total` и `truncated`, при `truncated: true` вызывающий сужает запрос.

Ответ по умолчанию — **строки по сущностям**: каждая достижимая сущность один раз, с минимальной глубиной и ребром, по которому её достигли (`via`), и вложенными свойствами из `include`:

```json
{"rows": [
  {"entity": "carl", "depth": 1,
   "via": {"relation": "friend_of", "from": "bob", "relation_id": 12, "time": {"axis": "game_day", "from": 100}},
   "properties": {"height": [186]}}
], "total": 1, "truncated": false}
```

При `paths: true` возвращаются полные пути (цепочки сущностей и связей с их временем) вместо `via`; путей не больше 10 000, иначе ошибка `too_many_paths` (сузить запрос). Сортировка и `limit` применяются к сущностям. «Самый высокий друг Боба» — один вызов: `depth: 1`, `include: ["height"]`, `order_by: {property: "height", dir: "desc"}`, `limit: 1`.

Внутри (режим по умолчанию): обход по уровням — рекурсивный CTE с `UNION` (дедупликация достигнутых сущностей) и фильтром времени на каждом шаге; несколько параллельных рёбер к одной сущности схлопываются в одну строку (в `via` — одно из них, плюс `via_count`). Затем присоединение `property_version` на тот же момент. Перебор всех путей (`paths: true`) на графе с хабами взрывается (спайк: 977 млн путей и 13 с на 500 стартов при хабе на 500 000 связей против 0,7 с у обхода по уровням), поэтому используется только при явном запросе и только с лимитом. SQL генерирует код сервера.

## 11. События

Наблюдение вроде «видел вчера Боба, он сделал сальтуху при мне» не укладывается в свойства и связи. Для него — отдельная сущность `event`: текст, ключевые слова, время, участники.

```sql
CREATE TABLE event (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  summary     text   NOT NULL,                 -- 1–2 фразы, то, что LLM увидит в выдаче
  details     text,                            -- необязательный подробный текст
  keywords    text[] NOT NULL DEFAULT '{}',    -- нормализованные (нижний регистр)
  evidence_id bigint REFERENCES evidence_log(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz,                     -- проставляется update_event
  retracted_at          timestamptz,
  retracted_evidence_id bigint REFERENCES evidence_log(id)
);
CREATE INDEX event_keywords_gin ON event USING gin (keywords);
CREATE INDEX event_text_trgm ON event
  USING gin ((summary || ' ' || coalesce(details, '')) gin_trgm_ops);

CREATE TABLE event_time (                      -- когда произошло, по шкалам
  event_id  bigint    NOT NULL REFERENCES event(id),
  time_axis smallint  NOT NULL REFERENCES time_axis(id),
  time_span int8range NOT NULL,
  instant   boolean   NOT NULL,                -- true: мгновенное событие, time_span = [t, t+1)
  PRIMARY KEY (event_id, time_axis)
);
CREATE INDEX event_time_axis_span ON event_time USING gist (time_axis, time_span);

CREATE TABLE event_entity (                    -- многие-ко-многим
  event_id  bigint NOT NULL REFERENCES event(id),
  entity_id bigint NOT NULL REFERENCES entity(entity_id),
  role      text   NOT NULL DEFAULT 'participant',   -- свободный нормализованный текст
  PRIMARY KEY (event_id, entity_id, role)
);
CREATE INDEX event_entity_entity_idx ON event_entity (entity_id, event_id);
```

- **Время.** У события всегда есть время хотя бы на одной шкале. Мгновенное событие: `{"axis": "game_day", "at": 300}` (`instant = true`, `[300, 301)`); длящееся: `{"axis": "game_day", "from": 299, "to": 301}` (границы опциональны). Маркер `instant` отличает «случилось в момент 300» от «длилось весь день 300».
- **Ключевые слова** пишет вызывающая сторона; система нормализует регистр. Словаря и статистики нет. Поиск: `keywords && ...` (`any`) или `keywords @> ...` (`all`) через GIN.
- **Текстовый поиск** по `summary` и `details` — подстрока через триграммный индекс (без оценок сходства).
- **Роли** участников — свободный нормализованный текст; `list_event_roles` возвращает уже использованные.
- **Участники** должны существовать как сущности (иначе `unknown_entity`, как для фактов).
- **Изменяемость.** Событие изменяется на месте, включая `summary`; истории версий нет (`updated_at` показывает, что событие правили). Ошибочное событие отзывается (`retract_event`).
- **Evidence необязателен** и может быть стёрт со временем (раздел 12), поэтому `summary` должен быть самодостаточным.
- Событие и факты связывает общий `evidence_id`; отдельной ссылки «факт выведен из события» нет.
- Связи между событиями (причина и следствие, последовательность) — v2.

Операции записи (в `apply`):

| Операция | Назначение |
|---|---|
| `add_event` | `summary`, `details?`, `keywords[]`, `time[]` (хотя бы одна запись), `entities[{entity, role?}]`, `evidence?`; возвращает `id` |
| `update_event` | `id` и любые из: `summary`, `details`, `keywords` (`{set}` или `{add, remove}`), `time` (замена по шкалам), `entities` (`{add, remove}`), `evidence` |
| `retract_event` | отозвать по `id` (необязательный `evidence`) |

Операции чтения (в `query`):

| Операция | Назначение |
|---|---|
| `get_event(id)` | событие со временем и участниками |
| `search_events({text?, keywords?, match?, entities?, when?, limit})` | поиск; `match` = `any` (по умолчанию) или `all` для ключевых слов; условия соединяются через AND; сортировка по времени события (новые первыми) |
| `entity_events(entity, when?, limit)` | события сущности |
| `list_event_roles` | использованные роли |

`when` для событий: `at` — события, чей интервал содержит момент; `during` — пересекающие промежуток. События без времени на указанной шкале в выборку по `when` не попадают. Ответы возвращают `total` и `truncated`, как `neighbors`.

## 12. Evidence

Evidence — исходный материал, из которого выведены факты и события. Он необязателен и может со временем стираться или обрезаться; факты и события должны оставаться понятными без него.

```sql
CREATE TABLE evidence_source (
  id             smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           text  NOT NULL UNIQUE,   -- 'telegram_message'
  plugin_id      smallint NOT NULL REFERENCES plugin(id),   -- плагин-источник (раздел 13)
  description    text  NOT NULL,          -- для LLM: что это за источник
  payload_schema jsonb NOT NULL           -- JSON Schema того, что присылает клиент
);

CREATE TABLE evidence_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id       smallint NOT NULL REFERENCES evidence_source(id),
  payload         jsonb,                  -- NULL после полного стирания
  created_at      timestamptz NOT NULL DEFAULT now(),
  retention_state jsonb,                  -- принадлежит плагину; ядро не читает
  purged_at       timestamptz,
  pinned          boolean NOT NULL DEFAULT false   -- не трогать политикой хранения
);
```

Принципы:
- **Клиент не знает про хранение.** LLM-клиент всегда присылает полный payload по `payload_schema`. Что сохранить и как состарить данные, решает плагин источника по собственной конфигурации (она хранится у плагина, не в БД; ядро видит её как непрозрачный JSON).
- **Любая запись проходит через плагин.** `add_evidence(source, payload)`: ядро проверяет payload по `payload_schema` (ошибка `invalid_payload`), затем передаёт плагину; тот возвращает то, что нужно сохранить (и, если нужно, начальное `retention_state`). Источник без зарегистрированного плагина — ошибка `unknown_source`.
- **Политика хранения целиком в плагине.** Ядру известны только `purged_at` и `pinned`.
- Сохранённый payload может быть подмножеством присланного, поэтому читатель не должен рассчитывать на наличие любых полей; `get_evidence(id)` возвращает оставшееся и `purged_at`.

Служебные операции (HTTP, не для LLM):
- `apply_retention({source?})` — ядро пачками передаёт плагину записи (кроме `pinned`) и текущий момент; плагин для каждой возвращает действие: оставить, заменить `payload` и `retention_state`, или стереть. Ядро применяет результат в транзакции (при стирании: `payload = NULL`, `purged_at = now()`). Операция идемпотентна, ответственность за идемпотентность на плагине. Автоматический запуск по расписанию — позже; в v1 вызывается вручную;
- `purge_evidence({ids | source, older_than})` — ручное полное стирание;
- `pin_evidence(id)` / `unpin_evidence(id)`.

Для LLM: `list_evidence_sources` (имя, описание, схема), `add_evidence`, `get_evidence`.

Механизм плагинов — раздел 13.

## 13. Плагины

Сервис написан на Node.js (TypeScript). Плагины — npm-пакеты, которые живут внутри сервиса (в его процессе). Один плагин может добавлять несколько шкал времени и несколько источников evidence. Назначение: шкалы времени (раздел 5) и источники evidence (раздел 12).

```sql
CREATE TABLE plugin (                -- создаётся раньше time_axis и evidence_source
  id      smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name    text  NOT NULL UNIQUE,     -- 'remora-core'
  package text  NOT NULL,            -- путь или имя npm-пакета
  config  jsonb NOT NULL             -- конфигурация плагина; единственный источник правды
);
```

### Форма плагина

```ts
export default definePlugin({
  name: 'remora-core',
  configSchema: { /* JSON Schema конфигурации */ },
  defaultConfig: { /* ... */ },
  setup(config) {
    return {
      timeAxes: [{ name, description, valueSchema, example,
                   encode(value): bigint, decode(n: bigint): value }],
      evidenceSources: [{ name, description, payloadSchema,
                          ingest(payload), planRetention(rows, now) }],
    };
  },
});
```

Функции плагина чистые: доступа к БД нет, данные и транзакции остаются за ядром. Кодирование возвращает `bigint`, чтобы не терять точность за пределами 2^53.

### Базовый плагин `remora-core`

Декларативный плагин, поставляемый вместе с сервисом. Его конфигурация описывает шкалы (`integer`, `datetime` с единицей, `packed` с компонентами и верхними границами разрядов) и простые источники evidence (схема payload, список сохраняемых полей, стадии старения по возрасту). Пример:

```json
{
  "timeAxes": [
    {"name": "game_day", "kind": "integer"},
    {"name": "real", "kind": "datetime", "unit": "seconds"},
    {"name": "story", "kind": "packed", "components": [
      {"name": "tome", "max": 999}, {"name": "chapter", "max": 999}, {"name": "scene", "max": 999}]}
  ],
  "evidenceSources": [
    {"name": "telegram_message", "schema": {"...": "..."},
     "keep": ["text", "sender", "chat_id", "sent_at", "attachments"],
     "retention": [{"after": "30 days", "drop": ["attachments"]}, {"after": "365 days", "drop": "*"}]}
  ]
}
```

Для нестандартных случаев пишется обычный плагин с кодом.

### Подключение пакетов (v1)

1. Оператор ставит пакет в каталог плагинов сервиса обычным менеджером пакетов (`npm install`, `pnpm add` и т.п.).
2. В служебном API (или UI) добавляется плагин по пути или имени пакета: `add_plugin({package})`. Ядро загружает пакет, читает `name` и `defaultConfig` и создаёт строку `plugin` с этим именем и конфигурацией по умолчанию. Служебные операции доступны только оператору, не LLM.
3. Добавление, удаление плагинов и смена `plugin.config` вступают в силу после перезапуска сервиса (горячей перезагрузки нет).

### Старт сервиса

Для каждой строки `plugin` загружается пакет, вызывается `setup(config)`, а полученные шкалы и источники записываются в `time_axis` и `evidence_source` (upsert по имени; описание, схема и пример копируются в строки, чтобы их можно было смотреть без плагина). Имя шкалы или источника, уже принадлежащее другому плагину, — ошибка при старте.

Если пакет плагина не загружается или `setup` падает, сервис продолжает работать в деградированном режиме: шкалы и источники этого плагина помечаются недоступными, операции с ними дают `axis_unavailable` / `source_unavailable`, остальное работает. Это громко пишется в лог при старте и видно в служебном статусе.

### Изменение конфигурации

Кодирование шкалы после записи данных не меняется; это дисциплина оператора (`encoding_version` не хранится). При изменении `plugin.config` служебный API предупреждает, если затронуты шкалы или источники, у которых уже есть данные, и требует явного подтверждения. Пересчёт старых данных (перекодирование шкал, повторный `planRetention`) в v1 не делается, см. v2.

## 14. Почему без графовой БД (результаты спайка)

Первоначально рассматривался Apache AGE (граф в PostgreSQL). Спайк (PostgreSQL 18.6, AGE 1.8.0, 10 000 вершин, 100 000 рёбер, 500 стартов, фильтр времени на каждом шаге):

| Запрос | AGE (Cypher) | Обычный SQL, индекс `(src, from, to)` |
|---|---|---|
| 5 шагов, 35 055 путей | 0,44 с | 0,04 с |
| 6 шагов, 72 657 путей | 0,57 с | 0,05 с |

Число путей совпало; рекурсивный CTE (достижимые вершины, глубина ≤ 5) — 15 мс. Граф синтетический (средняя степень около 10).

Причины отказа от AGE:
- через Cypher `CREATE`/`SET` не срабатывают внешние ключи (EXCLUDE и CHECK срабатывают); FK работают только при прямой SQL-вставке в таблицы меток с ручной сборкой `graphid`;
- дублирование сущностей (таблица и вершина) и синхронизация;
- переменная глубина с фильтром на путь падает (`no relation entry for relid 2`) — пришлось бы использовать фиксированные шаблоны;
- загрузка через Cypher очень медленная (100k рёбер за 10+ минут против 0,43 с SQL-вставкой);
- зависимость от внутреннего формата AGE, ограниченный хостинг.

Что теряется: графовые алгоритмы (кратчайший путь, PageRank) и язык шаблонов путей. При необходимости граф можно строить проекцией поверх таблицы `relation`.

## 15. Открытые вопросы

Закрыто спайком 2026-10-25 (схема раздела 3–7 на обычном PostgreSQL, те же 100k рёбер, что в замере раздела 14):
- **Индексы на `time_span`.** Хватает btree `(src, relation_type_id, time_axis)` и фильтра `time_span && ...` / `@>` по выбранным строкам: 5 шагов — 34 мс, 6 шагов — 42 мс (результаты совпали с AGE: 35 055 и 72 657 путей). GiST `(src, time_axis, time_span)` не нужен: на хабе он не ускорил запрос (12,9 мс против 6,0 мс только с btree).
- **EXCLUDE с `COALESCE`** работает (см. раздел 6).
- **Хаб.** Сущность с 50 000+ исходящих связей: соседи на момент `t` (13 919 строк) — 6 мс, обход на 2 шага с хаба (7 903 сущности) — 22 мс. Вставка 20 000 связей при двух индексах — 0,4 с.
- **Конкурентный `replace_property`.** Две сессии на одном свойстве: вторая получает `UPDATE 0` (строка уже закрыта первой), затем отклоняется EXCLUDE; в БД остаётся результат первой. Данные не портятся. API при `exclusion_violation` в `replace_property` возвращает типизированную ошибку `concurrent_update`, и клиент повторяет пакет.

Закрыто вторым спайком 2026-10-25 (670 000 связей, 5 типов, хаб на 500 000 связей, 200 000 текстовых значений):
- **Хаб на 500 000 связей.** Соседи хаба на момент `t` по одному типу (27 313 строк) — 17 мс; топ-5 по свойству среди соседей хаба по трём типам — 95 мс; обход хаба на 2 шага — 87 мс; обход по уровням на 5 шагов от хаба — 0,57 с; от 500 стартов при хабе в графе — 0,73 с (все 10 000 сущностей достигнуты).
- **Перебор путей взрывается:** 5 шагов от 500 стартов при хабе — 977 млн путей, 13,5 с. Поэтому по умолчанию `neighbors` использует обход по уровням с дедупликацией, а `paths: true` ограничен (раздел 10.3).
- **Несколько типов связей** в одном обходе (`relation_type_id = ANY(...)`) на скорость заметно не влияют.
- **Параллельные рёбра к одной сущности** дают дубли в топе: `neighbors` группирует по сущности.
- **`pg_trgm`.** Расширение доступно. Редкий запрос по триграммному индексу — 0,6 мс; частый (совпадает 20% строк) выигрыша от индекса не даёт (72 мс против 81 мс); поиск по `key` сущности — 0,5 мс.

Решено:
- безвременное и временные значения одноместного свойства взаимно исключаются на уровне API (`timeless_conflict`);
- секретный URL: один на сервис в v1;
- пагинации нет, есть `limit` с `total` и `truncated`.

- свободные данные (наблюдения вроде «видел вчера Боба, он сделал сальтуху») — отдельная сущность `event` (раздел 11);
- хранение evidence: плагин источника владеет проверкой, обрезкой и старением payload (раздел 12).

Открыто:
1. **Каталог плагинов в контейнере.** Где лежат установленные пакеты (смонтированный том) и как служебный API находит пакет по пути; проверить загрузку пакета при старте и деградацию при ошибке.
2. **EXCLUDE с условием `retracted_at IS NULL`** — проверить в плане (в спайке условие было только `single_valued`).
3. **События:** производительность `search_events` (ключевые слова, текст, фильтр по времени и участникам) не замерялась; проверить в плане.
4. **`apply_retention`:** размер пачки и порядок обработки; автозапуск по расписанию.
5. **Отложено на v2:** связи между событиями (причина и следствие, последовательность); фильтр и агрегаты в `neighbors`; `deprecate_type` и алиасы; `set_property_span` (правка границ истории); «сейчас» шкалы в `list_time_axes`; автоматическая политика хранения evidence по расписанию; миграция данных при смене конфигурации плагина (перекодирование шкал, повторное старение evidence; ядро поднимает старый и новый экземпляры плагина); установка плагинов из служебного API без ручного `npm install`; горячая загрузка и выгрузка плагинов.

## 16. Следующие шаги

1. Ревью этой спецификации.
2. План реализации (`superpowers:writing-plans`) после одобрения.
