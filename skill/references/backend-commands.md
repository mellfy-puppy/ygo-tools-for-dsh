# YGO Tool Guide

Use only the 14 YGO tools registered by the DeepSeek Harness plugin. Do not
invoke backend modules, HTTP endpoints, shell commands, or temporary scripts
during model decision work.

## Session Start

Call `manageEngineSession({action:"status"})` first. DeepSeek Harness binds the
current agent to one persistent engine session automatically; never create or
pass a session ID. Use `resetGame` for a new duel. Use `manageEngineSession`
actions `clear` or `shutdown` with `confirm:true` only for explicit teardown.

## Public Tools

- `queryCards`: `action:"get"` for one exact card; `action:"search"` for name,
  text, or type search.
- `manageCardDataSources`: `action:"inspect"` for local resource evidence;
  `action:"refresh"` with `allowNetworkUpdate:true` for an authorized update.
- `manageYgoPro2`: `action:"discover"` for installation readiness;
  `action:"status"` for the active real-duel bridge.
- `getBanlistContext`: parsed banlist evidence and optional card status.
- `manageSessionDeck`: actions `set`, `get`, `check`, `edit`, and `export`.
- `resetGame`: start an embedded or YGOPro2 duel. Use `fixedOpening` or
  `clearFixedOpening:true` to change the embedded opening atomically with reset.
- `observeDuel`: `action:"state"` for visible state or `action:"actions"` for
  current legal actions.
- `executeAction`: execute one legal action and return synchronized state and
  the next decision.
- `simulateActions`: compare a short embedded continuation without committing.
- `manageCheckpoint`: actions `save`, `restore`, `list`, and `delete`.
- `analyzeReplay`: actions `parse`, `context`, and `analyze`; `analyze` parses
  and builds model-readable context in one call.
- `analyzeCombo`: `action:"parse"` normalizes an artifact; `action:"adapt"`
  compares it with the loaded deck.
- `saveArtifact`: `action:"replay"` or `action:"route"`; use only for an
  explicitly requested file.
- `manageEngineSession`: actions `status`, `clear`, and `shutdown`.

## Discipline And Evidence

Pass unchanged YDK text to `manageSessionDeck({action:"set",ydk})`. Large
ordered selections are factorized and paged; use returned selection indexes.
A successful `executeAction` already returns synchronized `state` and
`nextDecision`, so observe again only after missing output, failure,
interruption, or no progress.

Start a real duel only with an explicit YGOPro2 backend, opponent profile, and
turn order. Discovery is not a live connection. Require
`manageYgoPro2({action:"status"})` evidence with `liveDuelBridge:true`; never
silently fall back to the embedded runner.

Real duels cannot use fixed openings, simulation, checkpoints, or rollback. To
end and export a running real duel, use
`saveArtifact({action:"replay",surrenderIfRunning:true,...})` only at the user's
request. A saved file is not proof that a combo completed or won.

Card claims require `queryCards`; deck claims require `manageSessionDeck` or
current-deck card evidence; state and legality claims require current duel tool
output; replay claims are limited to `analyzeReplay` output.
