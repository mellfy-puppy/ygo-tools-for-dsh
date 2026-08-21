# Data Resources

Use configurable paths for all YGO resources. Do not hardcode the original
project root, a user profile path, or provider secrets into generated workflows.

## Environment Variables

- `YGO_SKILL_ROOT`: override the skill root used for relative output/cache defaults.
- `YGO_RUNTIME_ROOT`: runtime engine/tool implementation root, defaulting to `runtime/`.
- `YGO_RESOURCES_ROOT`: bundled resources root, defaulting to `resources/`.
- `YGO_RESOURCE_ROOT`: active resource root, defaulting to `resources/`.
- `YGO_CARDS_DB`: SQLite `cards.cdb` path used for card names/effects.
- `YGO_CARDS_DBS`: optional semicolon-separated layered CDB paths. Default priority is prerelease updates, prerelease cards, then formal `cards.cdb`.
- `YGO_SCRIPTS_DIR`: Lua card script directory used by the engine.
- `YGO_SCRIPT_DIRS`: optional semicolon-separated layered script directories.
- `YGO_PRERELEASE_DIR`: official MyCard prerelease expansion directory.
- `YGO_PRERELEASE_RELEASE_DB`: override `test-release.cdb`.
- `YGO_PRERELEASE_UPDATE_DB`: override `test-update.cdb`.
- `YGO_PRERELEASE_SCRIPTS_DIR`: override the prerelease `script/` directory.
- `YGO_CACHE_DIR`: data-source/update cache directory.
- `YGO_REPLAY_DIR`: replay output directory for `saveArtifact`.
- `YGO_ROUTE_DIR`: route-report output directory for `saveArtifact`.
- `YGO_DECK_PATH`: default YDK path for examples and validation.
- `YGO_ID_MIGRATIONS`: old-to-current card ID migration manifest, defaulting to `resources/lib/id-migrations.json`.
- `YGO_ENGINE_BACKEND`: engine backend selector, default `js`.
- `YGO_ALLOW_NETWORK_UPDATE`: set to `1` to permit refresh operations.

Default resource discovery assumes this package layout:

```text
YGOagentskill/
  runtime/
    combo-simulator.cjs
    src/
  vendor/
    node_modules/
  resources/
    lib/cards.cdb
    lib/ygopro-scripts/
    lib/prerelease/test-release.cdb
    lib/prerelease/test-update.cdb
    lib/prerelease/test-strings.conf
    lib/prerelease/script/
    lib/slm.ydk
```

Relocated copies should work without absolute paths when the whole folder is
moved together. Set `YGO_RESOURCE_ROOT`, `YGO_CARDS_DB`, or `YGO_SCRIPTS_DIR`
only when using external card data or scripts.

## Built-In Runtime Dependencies

This skill keeps its portable JavaScript/WASM runtime dependencies under
`vendor/node_modules`. Backend code resolves these dependencies from the skill
folder first, so the packaged DSH skill remains self-contained when relocated.
Root-level `node_modules` is only for development updates.

Card database reads use the vendored `sql.js` runtime against the official
prerelease update/new-card CDBs followed by the bundled formal `cards.cdb`.

Native acceleration through `koffi`, a platform `ocgcore.dll`, or related FFI
helpers is not part of the default package. Treat native mode as an explicit
host-provided extension; the portable backend defaults to the JS/WASM engine.

## Inspection

Call `manageCardDataSources({action:"inspect"})` before route reasoning when card text, scripts,
cache age, or banlist freshness matters. The
inspection result should be reported to the host AI when a required database,
script directory, or cache is missing.

## Refresh Policy

The `manageCardDataSources` refresh action is disabled by default. It requires either
`allowNetworkUpdate:true` or `YGO_ALLOW_NETWORK_UPDATE=1`; otherwise it returns a
guarded failure such as `NETWORK_UPDATE_DISABLED`.

Only run refresh when the host explicitly wants network updates. Refreshing card
text without matching Lua scripts can leave the AI with text that the engine
cannot execute, so verify both `cards.cdb` and `ygopro-scripts` after updating.

## Skill Update Workflow

Use this exact sequence when a user asks the skill to update card data:

1. Call `manageCardDataSources({action:"inspect"})` and retain the reported paths, timestamps, sizes, and hashes.
2. Confirm the request explicitly authorizes a network-backed update. Never infer permission from an unrelated card lookup or duel request.
3. Call `manageCardDataSources` with `action:"refresh"` and `allowNetworkUpdate:true`. Do not bypass the guard in code or edit downloaded files manually.
4. Stage exactly two source layers in one transaction. The formal layer is the Koishi Chinese `cards.cdb`, `lflist.conf`, `strings.conf`, and complete `Smile-DK/ygopro-scripts` archive. The prerelease layer is MyCard's official `ygopro-super-pre.ypk` from `cdn02.moecube.com`, containing `test-update.cdb`, `test-release.cdb`, `test-strings.conf`, and `script/`.
5. Reject the prerelease package unless its CDB schemas are readable, every non-token card in `test-release.cdb` exists in the official `test-release-v2.json` catalog with the same name, and every executable CDB card has a Lua script. Catalog entries that are not yet present in the YPK CDB are metadata published ahead of the playable package: report them as `pendingCatalogCards` and do not install or synthesize them. They do not block the remaining complete YPK update.
6. Load CDBs in this order: prerelease `test-update.cdb`, prerelease `test-release.cdb`, formal `cards.cdb`. Load script directories in this order: prerelease `script/`, formal `ygopro-scripts/`. Earlier layers override later layers.
7. Do not use supplemental JSON, YGOPRODeck responses, BabelCDB, ProjectIgnis/CardScripts, or hand-authored card rows as fallback data. A card is available only when it exists in the formal or official prerelease CDB layer.
8. Every formal Lua file must match the Git blob hash from one non-truncated `Smile-DK/ygopro-scripts` tree revision. The archive must contain `constant.lua`, `utility.lua`, and `procedure.lua`, and may contain only flat Lua files plus the known `patches/` directory.
9. Check every card across both database layers that requires executable logic. Each must have its own `c<ID>.lua` or an alias script. Dynamically select representative main- and extra-deck cards from the newly downloaded prerelease CDB, start a real staged OCGCore runner, and require legal actions with no engine diagnostics. Never use fixed card IDs or names as update gates.
10. Only after all checks pass, replace the complete `resources/lib` directory in one directory-level transaction. Existing unmanaged files such as local YDK decks are copied into staging first. Any failed download, mismatch, missing script, or engine failure preserves the previous complete resource set.
11. Inspect again, then run the maintainer regressions `npm run test:resource-coherence`, `npm run test:prerelease`, and relevant behavior tests.
12. Report formal and prerelease hashes, the MyCard YPK version and archive hash, full layered database/script coverage, and generated `id-migrations.json` entries.

The updater writes only to configured resource/cache paths. Use `YGO_RESOURCE_ROOT` or the narrower path variables when the caller wants an external data directory; otherwise update the resources bundled with this skill.

## Evidence Rules

- Card lookup answers must cite `queryCards` output when available.
- Deck membership claims must come from `manageSessionDeck`.
- Banlist claims must come from `getBanlistContext` or inspected data sources.
- Engine execution claims require `resetGame`, `observeDuel`, `executeAction`, `simulateActions`, or replay evidence.
- Missing or stale data is a limitation to report, not a reason to invent card text.
