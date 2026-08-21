'use strict';

function createReplayExportApi(deps) {
  const {
    Buffer,
    CURRENT_DUEL_OPTIONS,
    makeXorshift32,
    getYgoproYrp,
  } = deps;

  const DEFAULT_OPPONENT_MAIN_DECK = Object.freeze([
    90241276, 81171949, 81171949, 70278545, 70278545,
    12058741, 48452496, 89023486, 72270339, 80845034,
    72270339, 72270339, 10966439, 68810435, 4215180,
    4215180, 31425736, 93360904, 29369059, 66975205,
    97631303, 12266229, 38648860, 97268402, 97268402,
    97268402, 10045475, 10045475, 10045475, 27204311,
    27204311, 42141493, 42141493, 23434538, 23434538,
    14558128, 14558128, 14558128, 4215180, 73642296,
  ]);

  function encodedActionToReplayResponse(action) {
    if (typeof action?.intResponse === 'number') {
      const out = new Uint8Array(4);
      new DataView(out.buffer).setInt32(0, action.intResponse | 0, true);
      return out;
    }
    if (typeof action?.responseBase64 === 'string') {
      return Uint8Array.from(Buffer.from(action.responseBase64, 'base64'));
    }
    return new Uint8Array(0);
  }

  function makeSeedSequence(seed, count = 8) {
    const rnd = makeXorshift32(seed ^ 0x6a09e667);
    const out = [];
    for (let index = 0; index < count; index += 1) {
      out.push((rnd() * 0x100000000) >>> 0);
    }
    return out;
  }

  function buildReplayMainDeck(openingInfo, fallbackMain) {
    const opening = openingInfo?.opening;
    const remain = openingInfo?.remain;
    if (Array.isArray(opening) && Array.isArray(remain) && opening.length > 0) {
      return [...remain, ...opening.slice().reverse()];
    }
    return [...(fallbackMain ?? [])];
  }

  function buildReplayDeckWithoutSide(openingInfo, deck) {
    return {
      main: buildReplayMainDeck(openingInfo, deck?.main),
      extra: [...(deck?.extra ?? [])],
      side: [],
    };
  }

  function ensureReplayOpponentDeck(deck, startHand) {
    const requiredCards = Math.max(1, Math.trunc(Number(startHand)) || 0);
    const main = Array.isArray(deck?.main) ? deck.main.slice() : [];
    if (main.length > 0 && main.length >= requiredCards) {
      return {
        main,
        extra: [...(deck?.extra ?? [])],
        side: [],
      };
    }

    const targetCount = Math.max(40, requiredCards);
    for (let index = main.length; index < targetCount; index += 1) {
      main.push(DEFAULT_OPPONENT_MAIN_DECK[index % DEFAULT_OPPONENT_MAIN_DECK.length]);
    }
    return {
      main,
      extra: [...(deck?.extra ?? [])],
      side: [],
    };
  }

  function exportReplayYrp(params) {
    const ygoproYrp = getYgoproYrp();
    if (!ygoproYrp?.YGOProYrp || !ygoproYrp?.ReplayHeader) {
      throw new Error('未检测到 ygopro-yrp-encode，无法导出 .yrp');
    }

    const {
      seed,
      drawCount,
      playerDeck,
      opponentDeck,
      playerOpening,
      opponentOpening,
      state,
      responsesEncoded,
      outPath,
      yrpVersion = 2,
      seedSequence = [],
    } = params;

    const sourceResponses =
      Array.isArray(responsesEncoded) && responsesEncoded.length > 0
        ? responsesEncoded
        : (state?.history ?? []);

    const responses = sourceResponses
      .map(encodedActionToReplayResponse)
      .filter((segment) => segment.length > 0);

    const {
      YGOProYrp,
      ReplayHeader,
      REPLAY_ID_YRP1,
      REPLAY_ID_YRP2,
      REPLAY_COMPRESSED_FLAG,
      REPLAY_UNIFORM,
    } = ygoproYrp;

    const header = new ReplayHeader();
    header.id = (yrpVersion === 2 ? REPLAY_ID_YRP2 : REPLAY_ID_YRP1) ?? 829452921;
    header.version = 4962;
    const compressedFlag = REPLAY_COMPRESSED_FLAG ?? 1;
    const uniformFlag = REPLAY_UNIFORM ?? 16;
    header.flag = yrpVersion === 2 ? (compressedFlag | uniformFlag) : compressedFlag;
    header.seed = seed >>> 0;
    header.hash = ((seed >>> 0) * 2654435761) >>> 0;
    header.props = [93, 0, 0, 32, 0, 0, 0, 0];
    if (yrpVersion === 2) {
      header.seedSequence = Array.isArray(seedSequence) && seedSequence.length > 0
        ? seedSequence.map((value) => value >>> 0)
        : makeSeedSequence(seed >>> 0);
      header.headerVersion = 1;
      header.value1 = 0;
      header.value2 = 0;
      header.value3 = 0;
    } else {
      header.seedSequence = [];
      header.headerVersion = 0;
      header.value1 = 0;
      header.value2 = 0;
      header.value3 = 0;
    }

    const startHand = Array.isArray(playerOpening?.opening) ? playerOpening.opening.length : drawCount;
    const yrp = new YGOProYrp({
      header,
      hostName: 'ComboBot',
      clientName: 'OpponentBot',
      startLp: 8000,
      startHand,
      drawCount: 1,
      opt: CURRENT_DUEL_OPTIONS,
      hostDeck: buildReplayDeckWithoutSide(playerOpening, playerDeck),
      clientDeck: ensureReplayOpponentDeck(buildReplayDeckWithoutSide(opponentOpening, opponentDeck), startHand),
      responses,
    });
    const fs = require('node:fs');
    const path = require('node:path');
    const bytes = yrp.toYrp();
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(bytes));
    return {
      outPath,
      responseCount: responses.length,
      byteLength: bytes.length,
    };
  }

  return {
    encodedActionToReplayResponse,
    makeSeedSequence,
    buildReplayMainDeck,
    exportReplayYrp,
  };
}

module.exports = {
  createReplayExportApi,
};
