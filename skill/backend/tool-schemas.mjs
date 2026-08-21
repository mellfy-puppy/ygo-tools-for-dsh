const cardId = { type: 'integer', minimum: 1, description: 'YGO card passcode.' };
const cardIdArray = { type: 'array', items: cardId };
const cardQuery = {
  anyOf: [
    cardId,
    { type: 'string', minLength: 1, description: 'Card name or numeric passcode string.' },
    {
      type: 'object',
      properties: {
        id: cardId,
        cardId,
        passcode: cardId,
        name: { type: 'string', minLength: 1 },
        cardName: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
  ],
};
const cardQueryArray = { type: 'array', minItems: 1, items: cardQuery };
const deck = {
  type: 'object',
  properties: { main: cardIdArray, extra: cardIdArray, side: cardIdArray },
  required: ['main'],
  additionalProperties: false,
};
const emptyObject = { type: 'object', properties: {}, additionalProperties: false };

export const TOOL_DESCRIPTIONS = Object.freeze({
  getCardEffect: 'Look up one card by name or passcode and return verified text and metadata from the configured database.',
  searchCards: 'Search verified card names, effect text, and optional card types in the configured database.',
  inspectCardDataSources: 'Inspect installed formal and prerelease databases, scripts, and banlists without downloading.',
  discoverYgoPro2: 'Discover local YGOPro2 installations, WindBot profiles, and verified bridge launch components without starting a process or claiming a live connection.',
  getYgoPro2BridgeStatus: 'Inspect whether this session is connected to a real AI.Server duel with a WindBot opponent.',
  refreshCardDataSources: 'Refresh official card data only when the user explicitly authorizes a network update.',
  getBanlistContext: 'Return parsed banlist context and optionally resolve one card status.',
  setSessionDeck: 'Load YDK text or a structured deck into the current in-memory session.',
  getSessionDeck: 'Return the complete deck currently loaded in the in-memory session.',
  checkDeckCards: 'Verify whether named cards or passcodes occur in the loaded deck and return copy counts.',
  editSessionDeck: 'Add, remove, set, or clear cards in one section of the loaded in-memory deck.',
  exportSessionDeck: 'Return the loaded deck as YDK text in memory; disk writes require explicit authorization.',
  setFixedOpening: 'Set or clear the exact fixed opening cards used by later resetGame calls.',
  resetGame: 'Create or reset the live duel runner with the loaded deck and exact fixed opening.',
  getCurrentState: 'Return the verified current duel state from the live runner.',
  listActions: 'Return a compact bounded page of current legal actions, optionally filtered by category, with factorized-selection constraints when a full combination set would be too large.',
  executeAction: 'Execute one current legal action and return the updated state plus next legal actions so another state/action fetch is normally unnecessary.',
  simulateActions: 'Simulate a short legal action sequence and restore the original live state afterward.',
  saveCheckpoint: 'Save the current live runner state as an in-memory checkpoint.',
  restoreCheckpoint: 'Restore an in-memory checkpoint by id, name, or latest checkpoint.',
  listCheckpoints: 'List in-memory checkpoint summaries for the current session.',
  deleteCheckpoint: 'Delete one or all in-memory checkpoints for the current session.',
  parseYrpRoute: 'Parse uploaded base64 replay bytes or a caller-provided replay file into verified route context.',
  buildRouteContext: 'Build model-readable route context from parsed replay data or the session fallback.',
  parseComboArtifact: 'Normalize an old combo archive, structured action list, code-produced JSON, or text route into portable semantic evidence.',
  buildComboAdaptationContext: 'Compare a normalized old combo with the currently loaded deck and produce engine-safe adaptation context.',
  saveReplayYrp: 'Save embedded response history or an authoritative raw AI.Server replay; a running real duel can be surrendered and exported atomically.',
  saveRouteFile: 'Save a verified route report after explicit user authorization.',
  getEngineSessionStatus: 'Inspect whether the persistent engine host still owns the current session, runner, deck, and checkpoints.',
  clearEngineSession: 'Explicitly destroy and clear only the current persistent engine session.',
  shutdownEngineHost: 'Explicitly destroy every engine session and stop the persistent local engine host process.',
});

export const TOOL_INPUT_SCHEMAS = Object.freeze({
  getCardEffect: {
    type: 'object',
    properties: {
      cardName: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1 },
      id: cardId, cardId, passcode: cardId,
    },
    anyOf: [
      { required: ['cardName'] }, { required: ['name'] }, { required: ['id'] },
      { required: ['cardId'] }, { required: ['passcode'] },
    ],
    additionalProperties: false,
  },
  searchCards: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1 },
      mode: { type: 'string', enum: ['all', 'name', 'text'], default: 'all' },
      type: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  inspectCardDataSources: emptyObject,
  discoverYgoPro2: {
    type: 'object',
    properties: {
      root: { type: 'string', minLength: 1 },
      roots: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 32 },
      searchRoots: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 32 },
      externalPolicyRoot: { type: 'string', minLength: 1 },
      externalPolicyRoots: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 32 },
      scan: { type: 'boolean', default: true },
      standardLocations: { type: 'boolean', default: true, description: 'Also check operating-system standard YGOPro2 locations.' },
      maxDepth: { type: 'integer', minimum: 0, maximum: 6, default: 2 },
      maxDirectories: { type: 'integer', minimum: 50, maximum: 10000, default: 1200 },
      maxInstallations: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    },
    additionalProperties: false,
  },
  getYgoPro2BridgeStatus: emptyObject,
  refreshCardDataSources: {
    type: 'object',
    properties: {
      allowNetworkUpdate: { type: 'boolean', description: 'Must be true after explicit user authorization.' },
      force: { type: 'boolean' }, progress: { type: 'boolean' },
      timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 },
      retryCount: { type: 'integer', minimum: 0, maximum: 5 },
    },
    required: ['allowNetworkUpdate'],
    additionalProperties: false,
  },
  getBanlistContext: {
    type: 'object',
    properties: {
      listName: { type: 'string', minLength: 1 }, listIndex: { type: 'integer', minimum: 0 },
      cardName: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1 },
      id: cardId, cardId, passcode: cardId,
    },
    additionalProperties: false,
  },
  setSessionDeck: {
    type: 'object',
    properties: {
      ydk: { type: 'string', minLength: 1 }, deckText: { type: 'string', minLength: 1 }, deck,
      name: { type: 'string', minLength: 1 }, fileName: { type: 'string', minLength: 1 },
      deckName: { type: 'string', minLength: 1 },
    },
    anyOf: [{ required: ['ydk'] }, { required: ['deckText'] }, { required: ['deck'] }],
    additionalProperties: false,
  },
  getSessionDeck: emptyObject,
  checkDeckCards: {
    type: 'object',
    properties: {
      cards: cardQueryArray,
      cardNames: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
      names: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
      ids: { ...cardIdArray, minItems: 1 }, cardIds: { ...cardIdArray, minItems: 1 },
      passcodes: { ...cardIdArray, minItems: 1 },
    },
    anyOf: [
      { required: ['cards'] }, { required: ['cardNames'] }, { required: ['names'] },
      { required: ['ids'] }, { required: ['cardIds'] }, { required: ['passcodes'] },
    ],
    additionalProperties: false,
  },
  editSessionDeck: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['add', 'remove', 'set', 'clear'] },
      section: { type: 'string', enum: ['main', 'extra', 'side'], default: 'main' },
      cardName: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1 },
      id: cardId, cardId, passcode: cardId,
      quantity: { type: 'integer', minimum: 0, maximum: 60 },
      count: { type: 'integer', minimum: 0, maximum: 60 },
    },
    required: ['operation'],
    additionalProperties: false,
  },
  exportSessionDeck: {
    type: 'object',
    properties: {
      save: { type: 'boolean' }, fileName: { type: 'string', minLength: 1 },
      file: { type: 'string', minLength: 1 }, outputPath: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  },
  setFixedOpening: {
    type: 'object',
    properties: {
      cards: cardQueryArray, cardIds: cardIdArray, playerOpeningCards: cardIdArray,
      openingCards: cardIdArray,
      cardNames: { type: 'array', items: { type: 'string', minLength: 1 } },
      names: { type: 'array', items: { type: 'string', minLength: 1 } },
      clear: { type: 'boolean' }, confirmUserRequestedClear: { type: 'boolean' },
    },
    anyOf: [
      { required: ['cards'] }, { required: ['cardIds'] }, { required: ['playerOpeningCards'] },
      { required: ['openingCards'] }, { required: ['cardNames'] }, { required: ['names'] },
      { required: ['clear'] },
    ],
    additionalProperties: false,
  },
  resetGame: {
    type: 'object',
    properties: {
      seed: { type: 'integer', minimum: 0, maximum: 4294967295 }, deck, playerDeck: deck,
      opponentDeck: deck, drawCount: { type: 'integer', minimum: 1 },
      duelBackend: { type: 'string', enum: ['embedded', 'ygopro2'] },
      ygoPro2Root: { type: 'string', minLength: 1 },
      externalPolicyRoot: { type: 'string', minLength: 1 },
      opponentAiProfile: { type: 'string', minLength: 1 },
      playerTurnOrder: {
        type: 'string',
        enum: ['first', 'second'],
        description: 'Required for duelBackend "ygopro2": choose whether the model-controlled player goes first or second.',
      },
      startupTimeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 },
      decisionTimeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 },
      openingCards: cardIdArray, playerOpeningCards: cardIdArray, opponentOpeningCards: cardIdArray,
      graveyardLimit: { type: 'integer', minimum: 1 },
    },
    additionalProperties: false,
  },
  getCurrentState: {
    type: 'object', properties: { graveyardLimit: { type: 'integer', minimum: 1, maximum: 50 } },
    additionalProperties: false,
  },
  listActions: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['summon', 'spsummon', 'activate', 'set', 'battle', 'phase', 'other'],
      },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      includeDescriptions: { type: 'boolean', default: false },
      includeGrouped: { type: 'boolean', default: false },
    },
    additionalProperties: false,
  },
  executeAction: {
    type: 'object',
    properties: {
      actionLabel: { type: 'string', minLength: 1 }, actionIndex: { type: 'integer', minimum: 0 },
      selectionIndexes: {
        type: 'array', minItems: 1, maxItems: 255, uniqueItems: true,
        items: { type: 'integer', minimum: 0, maximum: 255 },
        description: 'Original candidate indexes for a factorized multi-card selection.',
      },
      graveyardLimit: { type: 'integer', minimum: 1 },
      includeDescriptions: { type: 'boolean', default: false },
    },
    anyOf: [{ required: ['actionLabel'] }, { required: ['actionIndex'] }, { required: ['selectionIndexes'] }],
    additionalProperties: false,
  },
  simulateActions: {
    type: 'object',
    properties: {
      actionLabels: {
        type: 'array', minItems: 1, maxItems: 64,
        items: {
          anyOf: [
            { type: 'string', minLength: 1 }, { type: 'integer', minimum: 0 },
            {
              type: 'object',
              properties: { actionLabel: { type: 'string', minLength: 1 }, actionIndex: { type: 'integer', minimum: 0 } },
              anyOf: [{ required: ['actionLabel'] }, { required: ['actionIndex'] }],
              additionalProperties: false,
            },
          ],
        },
      },
      graveyardLimit: { type: 'integer', minimum: 1 },
    },
    required: ['actionLabels'],
    additionalProperties: false,
  },
  saveCheckpoint: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 80 }, note: { type: 'string', maxLength: 500 },
      overwrite: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  restoreCheckpoint: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1 },
      graveyardLimit: { type: 'integer', minimum: 1 },
    },
    additionalProperties: false,
  },
  listCheckpoints: {
    type: 'object', properties: { includeAutomatic: { type: 'boolean' } }, additionalProperties: false,
  },
  deleteCheckpoint: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1 }, all: { type: 'boolean' },
      includeAutomatic: { type: 'boolean' },
    },
    anyOf: [{ required: ['id'] }, { required: ['name'] }, { required: ['all'] }],
    additionalProperties: false,
  },
  parseYrpRoute: {
    type: 'object',
    properties: {
      yrpBase64: { type: 'string', minLength: 1 }, file: { type: 'string', minLength: 1 },
      fileName: { type: 'string', minLength: 1 },
      cardsDbPaths: { type: 'array', items: { type: 'string', minLength: 1 } },
      scriptDirs: { type: 'array', items: { type: 'string', minLength: 1 } },
    },
    anyOf: [{ required: ['yrpBase64'] }, { required: ['file'] }],
    additionalProperties: false,
  },
  buildRouteContext: {
    type: 'object',
    properties: {
      route: { type: 'object', additionalProperties: true }, summary: { type: 'object', additionalProperties: true },
      context: { type: 'object', additionalProperties: true }, source: { type: 'object', additionalProperties: true },
      replay: { type: 'object', additionalProperties: true }, deck: { type: 'object', additionalProperties: true },
      visibleSteps: { type: 'array' }, rawEvents: { type: 'array' }, warnings: { type: 'array' },
    },
    additionalProperties: true,
  },
  parseComboArtifact: {
    type: 'object',
    properties: {
      artifact: {
        anyOf: [{ type: 'object', additionalProperties: true }, { type: 'array' }],
        description: 'Parsed combo archive, structured combo object, or action array.',
      },
      json: {
        anyOf: [{ type: 'object', additionalProperties: true }, { type: 'array' }],
        description: 'Alias of artifact.',
      },
      content: { type: 'string', minLength: 1, description: 'Combo JSON or plain-text route content.' },
      text: { type: 'string', minLength: 1, description: 'Alias of content.' },
      file: { type: 'string', minLength: 1, description: 'Caller-provided combo archive, JSON, or text route path.' },
      maxSteps: { type: 'integer', minimum: 1, maximum: 2000 },
    },
    anyOf: [
      { required: ['artifact'] }, { required: ['json'] }, { required: ['content'] },
      { required: ['text'] }, { required: ['file'] },
    ],
    additionalProperties: false,
  },
  buildComboAdaptationContext: {
    type: 'object',
    properties: {
      parsed: { type: 'object', additionalProperties: true, description: 'Normalized output from parseComboArtifact.' },
      artifact: { type: 'object', additionalProperties: true },
      json: { type: 'object', additionalProperties: true },
      content: { type: 'string', minLength: 1 },
      text: { type: 'string', minLength: 1 },
      file: { type: 'string', minLength: 1 },
      maxSteps: { type: 'integer', minimum: 1, maximum: 2000 },
    },
    additionalProperties: false,
  },
  saveReplayYrp: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1 }, fileName: { type: 'string', minLength: 1 },
      yrpVersion: { type: 'integer', enum: [1, 2] }, replayDir: { type: 'string', minLength: 1 },
      surrenderIfRunning: { type: 'boolean', description: 'For a live AI.Server duel only: surrender before saving the authoritative server replay.' },
      surrenderTimeoutMs: { type: 'integer', minimum: 1000, maximum: 120000, default: 10000 },
    },
    additionalProperties: false,
  },
  saveRouteFile: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1 }, fileName: { type: 'string', minLength: 1 },
      format: { type: 'string', enum: ['markdown', 'json', 'txt'] },
      content: { type: 'string', minLength: 1, maxLength: 200000 }, routeDir: { type: 'string', minLength: 1 },
    },
    required: ['content'],
    additionalProperties: false,
  },
  getEngineSessionStatus: emptyObject,
  clearEngineSession: {
    type: 'object',
    properties: {
      confirm: { type: 'boolean', description: 'Must be true to explicitly clear the current engine session.' },
    },
    required: ['confirm'],
    additionalProperties: false,
  },
  shutdownEngineHost: {
    type: 'object',
    properties: {
      confirm: { type: 'boolean', description: 'Must be true to explicitly stop the host and clear all engine sessions.' },
    },
    required: ['confirm'],
    additionalProperties: false,
  },
});

const actionProperty = (values, description) => ({
  type: 'string',
  enum: values,
  description,
});

const mergeProperties = (...names) => Object.assign(
  {},
  ...names.map((name) => TOOL_INPUT_SCHEMAS[name]?.properties ?? {}),
);

export const PUBLIC_TOOL_DESCRIPTIONS = Object.freeze({
  queryCards: 'Look up one verified card or search verified card names, effect text, and card types.',
  manageCardDataSources: 'Inspect installed card data or perform an explicitly authorized official data refresh.',
  manageYgoPro2: 'Discover compatible local YGOPro2 components or inspect the current real AI.Server duel bridge.',
  getBanlistContext: TOOL_DESCRIPTIONS.getBanlistContext,
  manageSessionDeck: 'Load, inspect, query, edit, or export the deck bound to the current engine session.',
  resetGame: 'Create or reset the live duel runner, optionally setting or clearing the persistent fixed opening first.',
  observeDuel: 'Return the verified current duel state or a bounded page of current legal actions.',
  executeAction: TOOL_DESCRIPTIONS.executeAction,
  simulateActions: TOOL_DESCRIPTIONS.simulateActions,
  manageCheckpoint: 'Save, restore, list, or delete in-memory checkpoints for embedded-runner branch exploration.',
  analyzeReplay: 'Parse replay bytes or a replay file, build model-readable route context, or do both in one call.',
  analyzeCombo: 'Normalize a combo artifact or adapt it against the deck loaded in the current session.',
  saveArtifact: 'Save a replay or a verified route report after explicit user authorization.',
  manageEngineSession: 'Inspect, clear, or fully shut down the persistent engine session host.',
});

export const PUBLIC_TOOL_INPUT_SCHEMAS = Object.freeze({
  queryCards: {
    type: 'object',
    properties: {
      action: actionProperty(['get', 'search'], 'Use get for one exact card or search for a result list.'),
      ...mergeProperties('getCardEffect', 'searchCards'),
    },
    required: ['action'],
    additionalProperties: false,
  },
  manageCardDataSources: {
    type: 'object',
    properties: {
      action: actionProperty(['inspect', 'refresh'], 'Inspect local resources or refresh official resources.'),
      ...mergeProperties('refreshCardDataSources'),
    },
    required: ['action'],
    additionalProperties: false,
  },
  manageYgoPro2: {
    type: 'object',
    properties: {
      action: actionProperty(['discover', 'status'], 'Discover installations or inspect the active duel bridge.'),
      ...mergeProperties('discoverYgoPro2'),
    },
    required: ['action'],
    additionalProperties: false,
  },
  getBanlistContext: TOOL_INPUT_SCHEMAS.getBanlistContext,
  manageSessionDeck: {
    type: 'object',
    properties: {
      action: actionProperty(['set', 'get', 'check', 'edit', 'export'], 'Select the deck operation.'),
      ...mergeProperties('setSessionDeck', 'checkDeckCards', 'editSessionDeck', 'exportSessionDeck'),
    },
    required: ['action'],
    additionalProperties: false,
  },
  resetGame: {
    type: 'object',
    properties: {
      ...mergeProperties('resetGame'),
      fixedOpening: cardQueryArray,
      clearFixedOpening: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  observeDuel: {
    type: 'object',
    properties: {
      action: actionProperty(['state', 'actions'], 'Return current state or current legal actions.'),
      ...mergeProperties('getCurrentState', 'listActions'),
    },
    required: ['action'],
    additionalProperties: false,
  },
  executeAction: TOOL_INPUT_SCHEMAS.executeAction,
  simulateActions: TOOL_INPUT_SCHEMAS.simulateActions,
  manageCheckpoint: {
    type: 'object',
    properties: {
      action: actionProperty(['save', 'restore', 'list', 'delete'], 'Select the checkpoint operation.'),
      ...mergeProperties('saveCheckpoint', 'restoreCheckpoint', 'listCheckpoints', 'deleteCheckpoint'),
    },
    required: ['action'],
    additionalProperties: false,
  },
  analyzeReplay: {
    type: 'object',
    properties: {
      action: actionProperty(['parse', 'context', 'analyze'], 'Parse only, build context only, or parse and build context.'),
      ...mergeProperties('parseYrpRoute', 'buildRouteContext'),
    },
    required: ['action'],
    additionalProperties: false,
  },
  analyzeCombo: {
    type: 'object',
    properties: {
      action: actionProperty(['parse', 'adapt'], 'Normalize an artifact or adapt it to the loaded deck.'),
      ...mergeProperties('buildComboAdaptationContext', 'parseComboArtifact'),
    },
    required: ['action'],
    additionalProperties: false,
  },
  saveArtifact: {
    type: 'object',
    properties: {
      action: actionProperty(['replay', 'route'], 'Save a replay or route report.'),
      ...mergeProperties('saveReplayYrp', 'saveRouteFile'),
    },
    required: ['action'],
    additionalProperties: false,
  },
  manageEngineSession: {
    type: 'object',
    properties: {
      action: actionProperty(['status', 'clear', 'shutdown'], 'Inspect this session, clear it, or stop the entire engine host.'),
      confirm: { type: 'boolean', description: 'Must be true for clear or shutdown.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
});

export const PUBLIC_TOOL_NAMES = Object.freeze(Object.keys(PUBLIC_TOOL_DESCRIPTIONS));

export function getToolInputSchema(name) {
  return TOOL_INPUT_SCHEMAS[name] ?? emptyObject;
}

export function getPublicToolInputSchema(name) {
  return PUBLIC_TOOL_INPUT_SCHEMAS[name] ?? emptyObject;
}

export function validateToolInput(name, input) {
  const schema = TOOL_INPUT_SCHEMAS[name];
  if (!schema) {
    return { ok: false, errors: [{ path: '$', message: `No input schema is registered for tool ${name}.` }] };
  }
  const errors = validateValue(schema, input, '$');
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

export function validatePublicToolInput(name, input) {
  const schema = PUBLIC_TOOL_INPUT_SCHEMAS[name];
  if (!schema) {
    return { ok: false, errors: [{ path: '$', message: `No public input schema is registered for tool ${name}.` }] };
  }
  const errors = validateValue(schema, input, '$');
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

function validateValue(schemaValue, value, path) {
  const schema = asRecord(schemaValue);
  if (Object.keys(schema).length === 0) return [];
  const errors = [];

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const matches = schema.anyOf.some((candidate) => validateValue(candidate, value, path).length === 0);
    if (!matches) {
      const alternatives = schema.anyOf
        .flatMap((candidate) => Array.isArray(asRecord(candidate).required) ? asRecord(candidate).required : [])
        .filter((entry) => typeof entry === 'string');
      errors.push({
        path,
        message: alternatives.length > 0
          ? `Expected at least one of: ${[...new Set(alternatives)].join(', ')}.`
          : 'Value does not match any allowed schema.',
      });
    }
  }

  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.length > 0) {
    if (!isRecord(value)) {
      errors.push({ path, message: 'Expected an object with required properties.' });
    } else {
      for (const key of required) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) {
          errors.push({ path: `${path}.${key}`, message: 'Required property is missing.' });
        }
      }
    }
  }

  if (schema.type === 'object') {
    if (!isRecord(value)) return [...errors, { path, message: 'Expected an object.' }];
    const properties = asRecord(schema.properties);
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined || entry === null) continue;
      if (Object.hasOwn(properties, key)) {
        errors.push(...validateValue(properties[key], entry, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push({ path: `${path}.${key}`, message: 'Unknown property.' });
      }
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) return [...errors, { path, message: 'Expected an array.' }];
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) {
      errors.push({ path, message: `Expected at least ${schema.minItems} item(s).` });
    }
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) {
      errors.push({ path, message: `Expected at most ${schema.maxItems} item(s).` });
    }
    if (schema.uniqueItems === true) {
      const keys = value.map((entry) => JSON.stringify(entry));
      if (new Set(keys).size !== keys.length) errors.push({ path, message: 'Expected unique array items.' });
    }
    value.forEach((entry, index) => errors.push(...validateValue(schema.items ?? {}, entry, `${path}[${index}]`)));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') return [...errors, { path, message: 'Expected a string.' }];
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) {
      errors.push({ path, message: `Expected at least ${schema.minLength} character(s).` });
    }
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) {
      errors.push({ path, message: `Expected at most ${schema.maxLength} character(s).` });
    }
  } else if (schema.type === 'integer' || schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return [...errors, { path, message: `Expected a ${schema.type}.` }];
    }
    if (schema.type === 'integer' && !Number.isInteger(value)) errors.push({ path, message: 'Expected an integer.' });
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      errors.push({ path, message: `Expected a value >= ${schema.minimum}.` });
    }
    if (Number.isFinite(schema.maximum) && value > schema.maximum) {
      errors.push({ path, message: `Expected a value <= ${schema.maximum}.` });
    }
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') {
    errors.push({ path, message: 'Expected a boolean.' });
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) {
    errors.push({ path, message: `Expected one of: ${schema.enum.map(String).join(', ')}.` });
  }
  return errors;
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
