# Replay Workflow

Use `analyzeReplay` for `.yrp`, `.yrp2`, and `.yrp3d` inputs.

## Analyze

- `action:"parse"` parses `file` or `yrpBase64` and retains the latest parsed
  route in the DSH-bound engine session.
- `action:"context"` builds model-readable context from an explicit route or
  the latest parsed route.
- `action:"analyze"` performs both operations and returns `parsed` plus
  `context` in one call.

Plain `.yrp` primarily proves response history, while `.yrp3d` may also contain
client messages. Cite only fields returned by the parser and keep warnings
visible. Do not fill missing phases, choices, or movements from archetype
memory, and do not claim a route is complete from replay parsing alone.

## Save

Use `saveArtifact({action:"replay",...})` only when the user requests a saved
replay. Embedded export writes current response history to the configured
replay directory. A successful file write does not prove combo completion.

For a terminal YGOPro2 duel, the tool saves authoritative `STOC_REPLAY` bytes
unchanged. To end and export a running duel, pass `surrenderIfRunning:true` only
at the user's request. Publication is fail-closed: staged bytes must parse,
contain responses, and cover at least the model responses already submitted.
Invalid or incomplete staging files are deleted and no backup is retained.

Use `saveArtifact({action:"route",content,...})` for an explicitly requested
route report. Label evidence as executed, parsed, simulated, checkpoint, or
hypothetical according to the prompt references.
