# YGOPro YRP 2.5 Response Length Migration

YRP 2.5 extends replay response segment lengths without changing the replay
header magic. The change only affects the response stream after replay metadata,
deck data, or single-mode script data.

## Response Segment Format

Legacy YRP response segments use one byte for the payload length:

```text
[u8 length][payload bytes]
```

YRP 2.5 keeps that layout for normal non-empty responses from 1 to 255 bytes.
When the first length byte is `0x00`, it is an extended-length marker:

```text
[0x00][u16le length][payload bytes]
```

The effective YGOPro response payload limit is `SIZE_RETURN_VALUE = 512`.
Writers should skip zero-length response entries. Writers should cap payloads
longer than 512 bytes to the first 512 bytes and write length `512`.

## Compatibility

Replays containing only `1..255` byte responses are binary-identical to the
legacy format, as long as the caller does not include empty response entries.

Replays containing a response longer than 255 bytes require readers that support
the `0x00 + u16le` marker. Legacy readers interpret `0x00` as an empty response
and then read the two length bytes as later response data, which desynchronizes
the replay stream.

## gframe Migration Notes

Update the replay reader in `Replay::ReadNextResponse`:

- Read the first byte as `uint8_t len`.
- If `len != 0`, read `len` payload bytes as before.
- If `len == 0`, read a `uint16_t` little-endian length, then read that many
  payload bytes.
- If the declared extended length is greater than `SIZE_RETURN_VALUE`, consume
  the declared payload to keep replay alignment, but only copy the first
  `SIZE_RETURN_VALUE` bytes into the response buffer.
- Keep malformed or truncated tails non-fatal by returning `false` when the
  length or payload cannot be read.

Update all replay response writers:

- `SingleMode::SetResponse`
- `SingleDuel::GetResponse`
- `TagDuel::GetResponse`

Each writer should use a shared helper that caps the response length at
`SIZE_RETURN_VALUE`, writes the legacy one-byte prefix for lengths up to 255,
and writes `0x00 + u16le` for lengths from 256 to 512.

For retry rollback paths, update the recorded response byte count. Legacy
segments occupy `1 + len` bytes. Extended segments occupy `3 + len` bytes. This
matters for `last_replay_response_size` before calling `Replay::RemoveData`.

## Validation Checklist

- A replay with only `1..255` byte responses stays byte-for-byte identical.
- A 256-byte response is encoded as `00 00 01` followed by 256 payload bytes.
- A 512-byte response is encoded as `00 00 02` followed by 512 payload bytes.
- A payload longer than 512 bytes is recorded as a 512-byte response.
- A legacy client is not used to play replays containing extended response
  segments.
