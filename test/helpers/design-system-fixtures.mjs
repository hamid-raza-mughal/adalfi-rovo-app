// test/helpers/design-system-fixtures.mjs
// Minimal synthetic DesignSystemModel builders for testing generator logic in isolation
// (circular aliases, name collisions, unsupported constructs) that the real Figma export
// doesn't happen to contain. Not a test file itself (no *.test.mjs suffix), so `node --test`
// doesn't try to run it directly.

export function makeVariable({ id, name, collectionId, type = "FLOAT", valuesByMode, scopes = [], description = "" }) {
  return {
    id,
    key: id,
    name,
    collectionId,
    type,
    valuesByMode,
    scopes,
    description,
    codeSyntax: {},
    remote: false,
  };
}

export function makeCollection({ id, name, modes, defaultModeId }) {
  return { id, key: id, name, modes, defaultModeId, remote: false };
}

export function makeModel({ collections, variables, paint = [], text = [], effect = [], grid = [] }) {
  const collectionsById = new Map(collections.map((c) => [c.id, c]));
  const variablesById = new Map(variables.map((v) => [v.id, v]));
  return {
    meta: {
      schema_version: "test",
      exported_at: "2026-01-01T00:00:00.000Z",
      figma_file_name: "Test Fixture",
      figma_file_key: null,
      plugin_version: "test",
    },
    collections,
    collectionsById,
    variablesById,
    styles: { paint, text, effect, grid },
  };
}

export function literal(value) {
  return { kind: "literal", value };
}

export function alias(variableId, aliasName) {
  return { kind: "alias", variableId, aliasName };
}
