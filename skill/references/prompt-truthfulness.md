# Truthfulness Prompt

Use this prompt when fixed hands, route claims, replay context, or final answers
could be confused with verified engine facts.

## Claim Labels

- Do not claim a route is verified, complete, optimal, engine-tested, actually
  playable, saved, or fully reproduced unless successful backend results prove
  the specific claim.
- Chinese labels such as `引擎实测`, `实机验证`, `实际可打出`, `已验证`,
  `最优路线`, `终场一览`, and `路线报告` require matching evidence from the
  current session.
- If only simulations ran, call the result simulated. If only a replay was
  parsed, call it parsed replay evidence. If only a file was written, call it a
  saved file, not a completed route.

## Fixed Opening Hands

- A fixed opening hand is exact. Preserve the user-specified card identities,
  order when relevant, and count.
- Do not fill the hand to five cards, add random cards, use an incidental normal
  draw, or use unspecified future cards as combo resources.
- Once fixed opening is configured, do not clear it, replace it, switch to a
  random seed, or silently relax card identity unless the user explicitly asks.
- If fixed-opening reset fails because a card is missing or ambiguous, report
  the verified failure and inspect the deck/cards instead of using a random hand.

## Pending Decisions

- If tool output shows `terminal:false` with an unresolved decision such as
  card selection, position, place, yes/no, effect yes/no, or chain selection, the
  route is not finished.
- Resolve the pending decision with legal actions, or explicitly state that the
  route/replay is incomplete at that decision.
- A saved replay with `pendingDecision` or warnings is a partial or pending
  history unless the backend separately proves the combo is complete.

## Replay Truthfulness

- Plain `.yrp` files primarily provide response history. They do not expose the
  same client-message detail as YGOPro2 `.yrp3d` traces.
- `.yrp3d` client message streams are stronger evidence for visible route order
  when present, but still cite only parsed events and warnings.
- Never fill gaps in a replay from card names, archetype patterns, memory, or a
  plausible combo line.
- When replay parser warnings exist, surface the relevant limitation in the
  answer instead of smoothing it over.

## Legacy Combo Truthfulness

- A parsed combo archive, action list, generated JSON route, or text route is
  source evidence only. It is not proof that the route is legal, complete, or
  optimal in either the old or new deck.
- Preserve archive status such as `partial`, extracted warnings, old-deck
  differences, and non-portable binding counts.
- Do not describe an adapted route as verified until the new deck has been
  reset and every reported step has succeeded through current legal actions.
- Report any old-only card, unavailable fixed-opening card, unresolved card
  reference, changed lock, or unmapped step that affects the route.
