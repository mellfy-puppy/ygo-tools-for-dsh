'use strict';

function createReplayCliExportApi(deps) {
  const {
    path,
    process,
    resolveResourcePaths,
    assertFileExists,
    toInt,
    toUInt32,
    DEFAULT_OPTIONS,
    parseYrpVersion,
    parseYdkText,
    parseYdk,
    parseKeywordList,
    createSearchContext,
    cleanupRuntime,
    exportReplayYrp,
  } = deps;

  function resolveTopReplayOutputPaths(exportYrpArg, seed, topPathsCount) {
    const defaultDir = path.join(process.cwd(), 'replays', `combo-seed${seed}`);
    if (exportYrpArg === true || exportYrpArg === undefined) {
      const dir = path.resolve(defaultDir);
      return (depths) =>
        depths.map((depth, index) => path.join(dir, `top${index + 1}-depth${depth}.yrp`));
    }
    const resolved = path.resolve(String(exportYrpArg));
    if (topPathsCount === 1 && path.extname(resolved).toLowerCase() === '.yrp') {
      return () => [resolved];
    }
    const ext = path.extname(resolved).toLowerCase();
    if (ext === '.yrp') {
      const dir = path.dirname(resolved);
      const base = path.basename(resolved, ext);
      return (depths) =>
        depths.map((depth, index) => path.join(dir, `${base}-top${index + 1}-depth${depth}.yrp`));
    }
    return (depths) =>
      depths.map((depth, index) => path.join(resolved, `top${index + 1}-depth${depth}.yrp`));
  }

  async function exportCliSearchResults(params) {
    const {
      search,
      resourcePaths,
      drawCount,
      yrpVersion,
      playerDeck,
      opponentDeck,
      seed,
      maxDepth,
      maxNodes,
      targetTerminals,
      maxBeamWidth,
      maxActionsPerNode,
      snapshotPoolSize,
      expandScriptKeywords,
      exportYrpArg,
    } = params ?? {};
    if (!search?.exportItems?.length) {
      throw new Error('当前搜索结果没有可导出的录像');
    }
    const outputResolver = resolveTopReplayOutputPaths(
      exportYrpArg === undefined ? true : exportYrpArg,
      toUInt32(seed, DEFAULT_OPTIONS.seed),
      search.exportItems.length,
    );
    const outputPaths = outputResolver(search.exportItems.map((item) => item.depth));
    const files = [];
    for (let index = 0; index < search.exportItems.length; index += 1) {
      const item = search.exportItems[index];
      const { runtime, runner } = await createSearchContext({
        cardsPath: resourcePaths.cardsPath,
        scriptDirs: resourcePaths.scriptDirs,
        nativeScriptsRoot: resourcePaths.scriptsRoot,
        seed: item.seed >>> 0,
        drawCount,
        maxDepth,
        maxNodes,
        targetTerminals,
        maxBeamWidth,
        maxActionsPerNode,
        snapshotPoolSize,
        expandScriptKeywords,
        playerDeck,
        opponentDeck,
        playerOpening: item.opening,
        opponentOpening: item.opponentOpening,
        exactSingleSearch: true,
        engineBackend: 'wasm',
        yrpVersion,
      });
      try {
        const responsesEncoded = runner.buildReplayResponseHistory(item.state);
        const replayInfo = exportReplayYrp({
          seed: item.seed >>> 0,
          drawCount,
          playerDeck,
          opponentDeck,
          playerOpening: item.opening,
          opponentOpening: item.opponentOpening,
          state: item.state,
          responsesEncoded,
          outPath: outputPaths[index],
          yrpVersion,
          seedSequence: runner.seedSequence,
        });
        files.push({
          path: replayInfo.outPath,
          depth: item.depth,
          responseCount: replayInfo.responseCount,
          byteLength: replayInfo.byteLength,
        });
      } finally {
        await cleanupRuntime(runtime, runner);
      }
    }
    return {
      outputDir: path.dirname(files[0]?.path ?? ''),
      files,
    };
  }

  return {
    resolveTopReplayOutputPaths,
    exportCliSearchResults,
  };
}

module.exports = {
  createReplayCliExportApi,
};
