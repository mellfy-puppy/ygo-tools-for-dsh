'use strict';

function createNativeRandomRuntimeApi(deps) {
  const {
    Buffer,
    fs,
    process,
    initSqlJs,
    CardTextResolver,
    SqljsCardReader,
    NATIVE_OCGCORE_DLL_PATH,
    CURRENT_DUEL_OPTIONS,
    NATIVE_BOOTSTRAP_PRELOAD_SCRIPTS,
    COMMON,
    LOCATION_DECK,
    LOCATION_EXTRA,
    LOCATION_HAND,
    LOCATION_MZONE,
    LOCATION_SZONE,
    POS_FACEDOWN_DEFENSE,
    getKoffi,
    getYgoproCdb,
    buildReplayMainDeck,
    toUint8Array,
  } = deps;

  function buildNativeCardDataType() {
    const koffi = getKoffi();
    if (!koffi) return null;
    return koffi.struct('combo_native_card_data', {
      code: 'uint32_t',
      alias: 'uint32_t',
      setcode: koffi.array('uint16_t', 16),
      type: 'uint32_t',
      level: 'uint32_t',
      attribute: 'uint32_t',
      race: 'uint32_t',
      attack: 'int32_t',
      defense: 'int32_t',
      lscale: 'uint32_t',
      rscale: 'uint32_t',
      link_marker: 'uint32_t',
      rule_code: 'uint32_t',
    });
  }

  class NativeFfiDuel {
    constructor(runtime, params) {
      this.runtime = runtime;
      this.seed = params.seed >>> 0;
      this.seedSequence = Array.isArray(params.seedSequence) ? params.seedSequence.map((value) => value >>> 0) : [];
      this.yrpVersion = params.yrpVersion === 2 ? 2 : 1;
      this.drawCount = Math.max(0, params.drawCount ?? params.playerOpening?.opening?.length ?? 1);
      this.replayMode = !!params.replayMode;
      this.playerDeck = params.playerDeck;
      this.opponentDeck = params.opponentDeck;
      this.playerOpening = params.playerOpening;
      this.opponentOpening = params.opponentOpening;
      this.receiveBuffer = Buffer.alloc(Math.max(COMMON.SIZE_MESSAGE_BUFFER ?? 0x20000, 0x40000));
      this.returnBuffer = Buffer.alloc(Math.max(COMMON.SIZE_RETURN_VALUE ?? 0x1000, 0x1000));
      this.queryBuffer = Buffer.alloc(0x40000);
      this.fieldInfoBuffer = Buffer.alloc(0x4000);
      this.duelPtr = null;
      this.open();
    }

    loadDeck(deck, opening, owner, player) {
      this.loadCardList(opening.opening, owner, player, LOCATION_HAND);
      this.loadCardList(opening.remain, owner, player, LOCATION_DECK);
      this.loadCardList(deck.extra ?? [], owner, player, LOCATION_EXTRA);
    }

    loadReplayDeck(deck, opening, owner, player) {
      this.loadCardList(buildReplayMainDeck(opening, deck?.main ?? []), owner, player, LOCATION_DECK);
      this.loadCardList(deck.extra ?? [], owner, player, LOCATION_EXTRA);
    }

    loadCardList(codes, owner, player, location) {
      if (!Array.isArray(codes) || codes.length === 0) return;
      if (typeof this.runtime.loadDeckCards === 'function') {
        const payload = Buffer.alloc(codes.length * 4);
        codes.forEach((code, index) => {
          payload.writeUInt32LE(code >>> 0, index * 4);
        });
        this.runtime.loadDeckCards(
          this.duelPtr,
          payload,
          codes.length >>> 0,
          owner,
          player,
          location,
          POS_FACEDOWN_DEFENSE,
        );
        return;
      }
      let seq = 0;
      for (const code of codes) {
        this.runtime.newCard(this.duelPtr, code >>> 0, owner, player, location, seq, POS_FACEDOWN_DEFENSE);
        if (location === LOCATION_HAND || location === LOCATION_MZONE || location === LOCATION_SZONE) {
          seq += 1;
        }
      }
    }

    buildBootstrapPayload() {
      const makeCodeBuffer = (codes) => {
        const items = Array.isArray(codes) ? codes : [];
        if (items.length === 0) return null;
        const buffer = Buffer.alloc(items.length * 4);
        items.forEach((code, index) => {
          buffer.writeUInt32LE(code >>> 0, index * 4);
        });
        return buffer;
      };
      const buildPlayer = (deck, opening) => {
        const hand = this.replayMode ? [] : opening?.opening ?? [];
        const main = this.replayMode
          ? buildReplayMainDeck(opening, deck?.main ?? [])
          : opening?.remain ?? [];
        const extra = deck?.extra ?? [];
        const handBuffer = makeCodeBuffer(hand);
        const deckBuffer = makeCodeBuffer(main);
        const extraBuffer = makeCodeBuffer(extra);
        return {
          lp: 8000,
          startcount: this.replayMode ? this.drawCount : 0,
          drawcount: 1,
          hand: handBuffer,
          hand_count: hand.length >>> 0,
          deck: deckBuffer,
          deck_count: main.length >>> 0,
          extra: extraBuffer,
          extra_count: extra.length >>> 0,
        };
      };
      const player0 = buildPlayer(this.playerDeck, this.playerOpening);
      const player1 = buildPlayer(this.opponentDeck, this.opponentOpening);
      const scriptBuffer = Buffer.from(`${NATIVE_BOOTSTRAP_PRELOAD_SCRIPTS.join('\0')}\0`, 'utf8');
      return {
        options: CURRENT_DUEL_OPTIONS,
        script_data: scriptBuffer,
        script_length: scriptBuffer.length >>> 0,
        players: [player0, player1],
      };
    }

    open() {
      if (this.yrpVersion === 2 && this.seedSequence.length > 0) {
        const seedBuffer = this.runtime.allocSeedSequence(this.seedSequence);
        try {
          this.duelPtr = this.runtime.createDuelV2(seedBuffer);
        } finally {
          this.runtime.releaseSeedSequence(seedBuffer);
        }
      } else {
        this.duelPtr = this.runtime.createDuel(this.seed);
      }
      if (typeof this.runtime.bootstrapDuel === 'function') {
        const bootstrap = this.buildBootstrapPayload();
        const result = this.runtime.bootstrapDuel(this.duelPtr, bootstrap);
        if (result) {
          return;
        }
      }
      const startHand = this.replayMode ? this.drawCount : 0;
      this.runtime.setPlayerInfo(this.duelPtr, 0, 8000, startHand, 1);
      this.runtime.setPlayerInfo(this.duelPtr, 1, 8000, startHand, 1);
      for (const preload of NATIVE_BOOTSTRAP_PRELOAD_SCRIPTS) {
        try {
          this.runtime.preloadScript?.(this.duelPtr, preload);
        } catch {
          // ignore
        }
      }
      if (this.replayMode) {
        this.loadReplayDeck(this.playerDeck, this.playerOpening, 0, 0);
        this.loadReplayDeck(this.opponentDeck, this.opponentOpening, 1, 1);
      } else {
        this.loadDeck(this.playerDeck, this.playerOpening, 0, 0);
        this.loadDeck(this.opponentDeck, this.opponentOpening, 1, 1);
      }
      this.runtime.startDuel(this.duelPtr, CURRENT_DUEL_OPTIONS);
    }

    endDuel() {
      if (!this.duelPtr) return;
      try {
        this.runtime.endDuel(this.duelPtr);
      } catch {
        // ignore
      }
      this.duelPtr = null;
    }

    setResponse(response) {
      const bytes = Buffer.from(toUint8Array(response));
      this.returnBuffer.fill(0);
      bytes.copy(this.returnBuffer, 0, 0, Math.min(bytes.length, this.returnBuffer.length));
      this.runtime.setResponseB(this.duelPtr, this.returnBuffer);
    }

    setResponseInt(value) {
      this.runtime.setResponseI(this.duelPtr, value | 0);
    }

    queryFieldCard({ player, location, queryFlag }, { noParse } = {}) {
      if (!noParse) {
        throw new Error('NativeFfiDuel 仅支持 noParse queryFieldCard');
      }
      const length = this.runtime.queryFieldCard(
        this.duelPtr,
        player | 0,
        location | 0,
        queryFlag >>> 0,
        this.queryBuffer,
        0,
      );
      const safeLength = Math.max(0, length | 0);
      return {
        raw: Uint8Array.from(this.queryBuffer.subarray(0, safeLength)),
        length: safeLength,
      };
    }

    queryFieldInfo({ noParse } = {}) {
      if (!noParse) {
        throw new Error('NativeFfiDuel 仅支持 noParse queryFieldInfo');
      }
      const length = this.runtime.queryFieldInfo(this.duelPtr, this.fieldInfoBuffer);
      const safeLength = Math.max(0, length | 0);
      return {
        raw: Uint8Array.from(this.fieldInfoBuffer.subarray(0, safeLength)),
        length: safeLength,
      };
    }
  }

  async function createNativeRandomRuntime(cardsPath, scriptsRoot) {
    const koffi = getKoffi();
    const ygoproCdb = getYgoproCdb();
    if (!koffi || !ygoproCdb?.CardDataEntry) {
      throw new Error('native 随机搜索需要 koffi 和 ygopro-cdb-encode');
    }
    if (!fs.existsSync(NATIVE_OCGCORE_DLL_PATH)) {
      throw new Error(`native ocgcore.dll 不存在: ${NATIVE_OCGCORE_DLL_PATH}`);
    }

    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(cardsPath));
    const cardText = new CardTextResolver(db);
    const cardReader = SqljsCardReader(db);
    const cardPayloadCache = new Map();
    const originalCwd = process.cwd();
    process.chdir(scriptsRoot);

    const DuelHandle = koffi.pointer('combo_native_duel_handle', koffi.opaque());
    const CardData = buildNativeCardDataType();
    const BootstrapPlayer = koffi.struct('combo_native_bootstrap_player', {
      lp: 'int32_t',
      startcount: 'int32_t',
      drawcount: 'int32_t',
      hand: 'void *',
      hand_count: 'uint32_t',
      deck: 'void *',
      deck_count: 'uint32_t',
      extra: 'void *',
      extra_count: 'uint32_t',
    });
    const BootstrapDuel = koffi.struct('combo_native_bootstrap_duel', {
      options: 'uint32_t',
      script_data: 'void *',
      script_length: 'uint32_t',
      players: koffi.array(BootstrapPlayer, 2),
    });
    koffi.proto('combo_native_card_reader', 'uint32_t', ['uint32_t', koffi.pointer(CardData)]);
    koffi.proto('combo_native_message_handler', 'uint32_t', [DuelHandle, 'uint32_t']);

    const lib = koffi.load(NATIVE_OCGCORE_DLL_PATH);
    const runtime = {
      kind: 'native-random',
      db,
      cardText,
      lib,
      originalCwd,
      scriptsRoot,
      createDuel: lib.func('create_duel', DuelHandle, ['uint32_t']),
      createDuelV2: lib.func('create_duel_v2', DuelHandle, ['void *']),
      bootstrapDuel: lib.func('bootstrap_duel', 'int32_t', [DuelHandle, koffi.pointer(BootstrapDuel)]),
      startDuel: lib.func('start_duel', 'void', [DuelHandle, 'uint32_t']),
      endDuel: lib.func('end_duel', 'void', [DuelHandle]),
      setPlayerInfo: lib.func('set_player_info', 'void', [DuelHandle, 'int32_t', 'int32_t', 'int32_t', 'int32_t']),
      getMessage: lib.func('get_message', 'int32_t', [DuelHandle, 'void *']),
      process: lib.func('process', 'uint32_t', [DuelHandle]),
      preloadScript: lib.func('preload_script', 'int32_t', [DuelHandle, 'str']),
      loadDeckCards: lib.func('load_deck_cards', 'void', [DuelHandle, 'void *', 'uint32_t', 'uint8_t', 'uint8_t', 'uint8_t', 'uint8_t']),
      newCard: lib.func('new_card', 'void', [DuelHandle, 'uint32_t', 'uint8_t', 'uint8_t', 'uint8_t', 'uint8_t', 'uint8_t']),
      setResponseI: lib.func('set_responsei', 'void', [DuelHandle, 'int32_t']),
      setResponseB: lib.func('set_responseb', 'void', [DuelHandle, 'void *']),
      queryFieldCard: lib.func('query_field_card', 'int32_t', [DuelHandle, 'uint8_t', 'uint8_t', 'uint32_t', 'void *', 'int32_t']),
      queryFieldInfo: lib.func('query_field_info', 'int32_t', [DuelHandle, 'void *']),
    };

    runtime.defaultScriptReader = lib.symbol('default_script_reader', 'void *');
    runtime.setScriptReader = lib.func('void set_script_reader(void *reader)');
    runtime.setCardReader = lib.func('void set_card_reader(combo_native_card_reader *reader)');
    runtime.setMessageHandler = lib.func('void set_message_handler(combo_native_message_handler *handler)');

    runtime.seedSequenceBuffers = new Set();
    runtime.allocSeedSequence = (seedSequence) => {
      const values = Array.isArray(seedSequence) ? seedSequence : [];
      const buffer = Buffer.alloc(Math.max(1, values.length) * 4);
      values.forEach((value, index) => {
        buffer.writeUInt32LE(value >>> 0, index * 4);
      });
      runtime.seedSequenceBuffers.add(buffer);
      return buffer;
    };
    runtime.releaseSeedSequence = (buffer) => {
      runtime.seedSequenceBuffers.delete(buffer);
    };

    runtime.cardCallback = koffi.register((code, dataPtr) => {
      const cacheKey = code >>> 0;
      let payload = cardPayloadCache.get(cacheKey) ?? null;
      if (!payload) {
        const entry = cardReader(cacheKey);
        if (!entry) return 0;
        payload = Buffer.from(
          entry instanceof ygoproCdb.CardDataEntry
            ? entry.toPayload()
            : new ygoproCdb.CardDataEntry().fromPartial(entry).toPayload(),
        );
        cardPayloadCache.set(cacheKey, payload);
      }
      const target = Buffer.from(koffi.view(dataPtr, payload.length));
      payload.copy(target, 0, 0, payload.length);
      return 0;
    }, 'combo_native_card_reader *');
    runtime.messageCallback = koffi.register(() => 0, 'combo_native_message_handler *');
    runtime.setScriptReader(runtime.defaultScriptReader);
    runtime.setCardReader(runtime.cardCallback);
    runtime.setMessageHandler(runtime.messageCallback);
    return runtime;
  }

  return {
    buildNativeCardDataType,
    NativeFfiDuel,
    createNativeRandomRuntime,
  };
}

module.exports = {
  createNativeRandomRuntimeApi,
};
