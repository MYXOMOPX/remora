CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE plugin (
  id      smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name    text  NOT NULL UNIQUE,
  package text  NOT NULL,
  config  jsonb NOT NULL
);

CREATE TABLE relation_type (
  id          smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  description text NOT NULL,
  directed    boolean NOT NULL
);

CREATE TABLE property_type (
  id            smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  description   text NOT NULL,
  value_type    text NOT NULL CHECK (value_type IN ('number', 'text', 'date', 'bool', 'json')),
  single_valued boolean NOT NULL,
  UNIQUE (id, single_valued)
);

CREATE TABLE entity (
  entity_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key       text NOT NULL UNIQUE
);
CREATE INDEX entity_key_trgm ON entity USING gin (key gin_trgm_ops);

CREATE TABLE time_axis (
  id     smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name   text NOT NULL UNIQUE,
  plugin_id    smallint NOT NULL REFERENCES plugin(id),
  description  text  NOT NULL,
  value_schema jsonb NOT NULL,
  example      jsonb NOT NULL
);

CREATE TABLE evidence_source (
  id             smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           text  NOT NULL UNIQUE,
  plugin_id      smallint NOT NULL REFERENCES plugin(id),
  description    text  NOT NULL,
  payload_schema jsonb NOT NULL
);

CREATE TABLE evidence_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id       smallint NOT NULL REFERENCES evidence_source(id),
  payload         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  retention_state jsonb,
  purged_at       timestamptz,
  pinned          boolean NOT NULL DEFAULT false
);

CREATE TABLE property_version (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_id        bigint    NOT NULL REFERENCES entity(entity_id),
  property_type_id smallint  NOT NULL,
  single_valued    boolean   NOT NULL,
  time_axis        smallint  REFERENCES time_axis(id),
  time_span        int8range,
  value            jsonb     NOT NULL,
  evidence_id      bigint    REFERENCES evidence_log(id),
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  retracted_at          timestamptz,
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

CREATE INDEX property_version_text_trgm ON property_version
  USING gin ((value #>> '{}') gin_trgm_ops) WHERE jsonb_typeof(value) = 'string';

CREATE TABLE relation (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  relation_id      bigint NOT NULL,
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

CREATE TABLE event (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  summary     text   NOT NULL,
  details     text,
  keywords    text[] NOT NULL DEFAULT '{}',
  evidence_id bigint REFERENCES evidence_log(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz,
  retracted_at          timestamptz,
  retracted_evidence_id bigint REFERENCES evidence_log(id)
);
CREATE INDEX event_keywords_gin ON event USING gin (keywords);
CREATE INDEX event_text_trgm ON event
  USING gin ((summary || ' ' || coalesce(details, '')) gin_trgm_ops);

CREATE TABLE event_time (
  event_id  bigint    NOT NULL REFERENCES event(id),
  time_axis smallint  NOT NULL REFERENCES time_axis(id),
  time_span int8range NOT NULL,
  instant   boolean   NOT NULL,
  PRIMARY KEY (event_id, time_axis),
  CHECK ((NOT instant) OR (lower(time_span) IS NOT NULL AND upper(time_span) = lower(time_span) + 1))
);
CREATE INDEX event_time_axis_span ON event_time USING gist (time_axis, time_span);

CREATE TABLE event_entity (
  event_id  bigint NOT NULL REFERENCES event(id),
  entity_id bigint NOT NULL REFERENCES entity(entity_id),
  role      text   NOT NULL DEFAULT 'participant',
  PRIMARY KEY (event_id, entity_id, role)
);
CREATE INDEX event_entity_entity_idx ON event_entity (entity_id, event_id);
