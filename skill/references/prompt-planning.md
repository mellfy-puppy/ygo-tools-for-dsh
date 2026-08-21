# Planning Prompt

Use this prompt when deriving a combo line, comparing branches, or deciding how
to mutate a live runner state.

## Route Planning Loop

1. Sketch the global objective: target end board, desired interruptions,
   resource loops, material needs, known locks, and acceptable incomplete states.
2. Verify the concrete starting point: loaded deck, fixed opening, current hand,
   field, graveyard, banished cards, extra deck, and legal actions.
3. Verify relevant card text and current deck membership before using a card as a
   route resource.
4. Identify the main candidate branches from tool evidence instead of semantic
   association. Narrow the set, but keep enough alternatives for real comparison.
5. Use `simulateActions` for short uncertain sequences and checkpoints for live
   branch exploration.
6. Execute the best verified branch step by step. Each successful
   `executeAction` already returns synchronized `state` and
   `nextDecision.actions`; use those directly. Call `observeDuel` separately
   only after failure, interruption, truncation, or
   missing data.
7. Keep the entire route in the host's live session. Do not externalize the loop
   into model-authored code or reconstruct state from prose.

## Legacy Combo Adaptation

- Call `analyzeCombo({action:"parse",...})` for an old combo archive, structured action list,
  code-produced JSON, or text route. Do not write a parser script for a format
  the backend accepts.
- Load the new deck, then call `analyzeCombo({action:"adapt"})` to compare old and
  current deck contents, fixed-opening availability, referenced cards, semantic
  steps, and non-portable bindings.
- Reuse intent, prerequisites, card roles, material requirements, targets, and
  zone strategy. Do not reuse old action indices, candidate positions, card
  instance IDs, or `responseBase64` bytes.
- Treat partial archives and text routes as reference evidence. They do not
  prove route completion, optimality, or legality in the new deck.
- Restart from the new deck and fixed opening, use the latest returned legal
  actions at each live decision, and engine-verify every adapted step before
  reporting success. Call `observeDuel({action:"actions"})` only when the current tool result does
  not already contain the decision's actions.
- Mark missing old cards, replacement assumptions, changed locks, changed
  materials, and unreachable steps explicitly instead of silently substituting.

## Branch Comparison

- Compare branches directly from verified game facts: bodies, card advantage,
  searches, locks, zones, follow-up, interruptions, remaining resources, and
  the user's stated objective. Do not reduce a branch to a numeric ranking.
- Before making a non-placement multi-option choice, inspect relevant card
  effects, deck membership, current state, legal actions, and the user goal.
  This applies to search/send/summon/material/target/chain choices and similar
  selections.
- Do not pick a card merely because it looks familiar or archetypally correct.
  If you cannot explain why it beats the main alternatives with tool evidence,
  gather more evidence before executing.
- Do not mechanically enumerate every possible branch. Use verified card text,
  route goals, and current legal actions to choose a compact branch set.

## Productive Branches

- Do not treat a branch as dead merely because it missed the final board in one
  step. If it produced bodies, graveyard material, searches, summons, levels,
  ranks, links, zones, locks, or other resources, inspect what those resources
  can still become.
- Before restoring away from a productive branch, retain an in-memory continuation
  assessment: gained resources, unsatisfied goals, legal follow-up actions,
  plausible conversions, known locks, and the tool evidence behind the judgment.
- A branch is a dead end only when tools show no useful legal follow-up, a
  required resource is unavailable in the current deck/state, or a lock/rule
  constraint makes the goal impossible from that branch.

## Rollback Ladder

- Restore only to the latest decision that can plausibly change the blocker.
- Prefer the smallest useful rollback first: last send/search/summon/material/
  zone/chain/target choice, then last summon target, then route-root choice.
- Do not abandon a higher-level route choice until the latest relevant choice
  point has been exhausted or proven irrelevant by tools.
- Use `manageCheckpoint` actions for real in-memory rollback. Do not write checkpoint files
  or fake rollback in text.
- Every successful `executeAction` returns an `automaticCheckpoint` created
  immediately before that mutation. Use it as the smallest rollback point;
  create a named manual checkpoint at important strategic branch roots.
- On a later conversation turn, call `manageEngineSession({action:"status"})`
  and `manageCheckpoint({action:"list"})` before acting. Continue the existing Runner instead of
  reconstructing or replaying the route.
- Do not create separate scripts for competing branches. Save the common root
  once, simulate or execute a branch, then restore the smallest relevant checkpoint.

## Dynamic Link-Zone And Placement Thinking

- Treat `fieldContext.summary`, `currentLinkZones`, and `linkMonsters` from
  state/action/simulation payloads as live global state. Reread them after every
  summon, link summon, removal, or movement.
- Before choosing a monster zone, inspect occupied zones, link arrows, linked
  zones, extra monster zones, and zones needed by planned extra deck summons.
- Zone labels are strategic facts, not cosmetic labels. Use the exact zone label
  returned by `observeDuel({action:"actions"})` when executing or explaining placement.
- Non-Link monsters should not casually occupy linked zones needed later, and
  should not casually occupy the Extra Monster Zone unless the verified route
  needs that placement now.

## One-Turn Default

Combo derivation is one-turn by default. Do not plan, execute, or claim progress
that depends on passing turn, opponent action, next draw phase, future standby
phases, or any later turn unless the user explicitly asks for cross-turn
analysis.
