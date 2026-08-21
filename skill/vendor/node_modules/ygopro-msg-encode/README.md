# ygopro-msg-encode

[![npm version](https://img.shields.io/npm/v/ygopro-msg-encode.svg)](https://www.npmjs.com/package/ygopro-msg-encode)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A TypeScript library for encoding and decoding YGOPro network protocols.

## Features

- 🎯 **Complete Protocol Support**: Implements all YGOPro network protocols (MSG, CTOS, STOC)
- 🔒 **Type-Safe**: Full TypeScript support with detailed type definitions
- ⚡ **High Performance**: Efficient binary serialization/deserialization
- 🎨 **Modern API**: Clean and intuitive API design with `toFullPayload()` / `fromFullPayload()`
- 📦 **Zero Config**: Works out of the box with sensible defaults
- 🧪 **Well Tested**: 100+ unit tests with comprehensive coverage
- 🌍 **Universal**: Supports both CommonJS and ES Modules

## Installation

```bash
npm install ygopro-msg-encode
```

## Quick Start

### CTOS (Client to Server) Protocols

```typescript
import { YGOProCtosChat, YGOProCtos } from 'ygopro-msg-encode';

// Serialize a chat message
const chat = new YGOProCtosChat();
chat.msg = "Hello, YGOPro!";
const payload = chat.toFullPayload();

// Send to server
socket.send(payload);

// Deserialize received data
const received = new YGOProCtosChat();
received.fromFullPayload(payload);
console.log(received.msg); // "Hello, YGOPro!"

// Auto-detect protocol type using Registry
const parsed = YGOProCtos.getInstanceFromPayload(payload);
if (parsed instanceof YGOProCtosChat) {
  console.log('Chat message:', parsed.msg);
}
```

### STOC (Server to Client) Protocols

```typescript
import { YGOProStocChat, YGOProStoc } from 'ygopro-msg-encode';

// Serialize a server chat message
const chat = new YGOProStocChat();
chat.player_type = 0x10; // System message
chat.msg = "Welcome to the duel!";
const payload = chat.toFullPayload();

// Deserialize
const received = new YGOProStocChat();
received.fromFullPayload(payload);
console.log(`[${received.player_type}] ${received.msg}`);

// Auto-detect using Registry
const parsed = YGOProStoc.getInstanceFromPayload(payload);
```

### MSG (Game Messages) Protocols

```typescript
import { YGOProMsgHint, YGOProMessages } from 'ygopro-msg-encode';

// Create a hint message
const hint = new YGOProMsgHint();
hint.type = 1;
hint.player = 0;
hint.desc = 0x1234;

// Serialize
const payload = hint.toPayload();

// Deserialize with auto-detection
const parsed = YGOProMessages.getInstanceFromPayload(payload);
if (parsed instanceof YGOProMsgHint) {
  console.log('Hint type:', parsed.type);
}
```

## Protocol Format

### CTOS/STOC Packet Structure

```
┌────────────┬────────────────┬──────────────┐
│ Length     │ Identifier     │ Body         │
│ 2 bytes LE │ 1 byte         │ Variable     │
└────────────┴────────────────┴──────────────┘

Length = 1 (identifier) + body.length
```

### MSG Packet Structure

```
┌────────────────┬──────────────┐
│ Identifier     │ Body         │
│ 1 byte         │ Variable     │
└────────────────┴──────────────┘
```

## API Reference

### Base Classes

#### `toFullPayload(): Uint8Array`

Serializes the protocol instance to a complete packet including header.

```typescript
const protocol = new YGOProCtosPlayerInfo();
protocol.name = [0x41, 0x42, 0x43, ...]; // "ABC"
const fullPayload = protocol.toFullPayload();
```

#### `fromFullPayload(data: Uint8Array): this`

Deserializes a complete packet including header.

```typescript
const protocol = new YGOProCtosPlayerInfo();
protocol.fromFullPayload(fullPayload);
console.log(protocol.name);
```

**Features:**
- Automatically validates packet length
- Automatically validates identifier
- Auto-truncates extra data if packet is longer than declared
- Throws clear errors if packet is invalid

**Error Handling:**

```typescript
try {
  protocol.fromFullPayload(data);
} catch (error) {
  if (error.message.includes('too short')) {
    console.error('Incomplete packet');
  } else if (error.message.includes('identifier mismatch')) {
    console.error('Wrong protocol type');
  }
}
```

#### `toPayload(): Uint8Array`

Serializes only the body part (without header).

```typescript
const body = protocol.toPayload();
```

#### `fromPayload(data: Uint8Array): this`

Deserializes only the body part (without header).

```typescript
protocol.fromPayload(bodyData);
```

### Registry System

#### Auto-Detection

```typescript
import { YGOProCtos, YGOProStoc, YGOProMessages } from 'ygopro-msg-encode';

// CTOS protocols
const ctosProtocol = YGOProCtos.getInstanceFromPayload(fullPayload);

// STOC protocols
const stocProtocol = YGOProStoc.getInstanceFromPayload(fullPayload);

// MSG protocols
const msgProtocol = YGOProMessages.getInstanceFromPayload(bodyPayload);
```

## Supported Protocols

### CTOS Protocols (19)

| ID | Protocol | Description |
|----|----------|-------------|
| 0x01 | CTOS_RESPONSE | Response with data |
| 0x02 | CTOS_UPDATE_DECK | Update deck (using ygopro-deck-encode) |
| 0x03 | CTOS_HAND_RESULT | Hand result |
| 0x04 | CTOS_TP_RESULT | Turn player result |
| 0x10 | CTOS_PLAYER_INFO | Player information |
| 0x11 | CTOS_CREATE_GAME | Create game |
| 0x12 | CTOS_JOIN_GAME | Join game |
| 0x13 | CTOS_LEAVE_GAME | Leave game |
| 0x14 | CTOS_SURRENDER | Surrender |
| 0x15 | CTOS_TIME_CONFIRM | Time confirm |
| 0x16 | CTOS_CHAT | Chat message (variable length) |
| 0x17 | CTOS_EXTERNAL_ADDRESS | External address (variable length) |
| 0x20 | CTOS_HS_TODUELIST | Host: to duelist |
| 0x21 | CTOS_HS_TOOBSERVER | Host: to observer |
| 0x22 | CTOS_HS_READY | Host: ready |
| 0x23 | CTOS_HS_NOTREADY | Host: not ready |
| 0x24 | CTOS_HS_KICK | Host: kick player |
| 0x25 | CTOS_HS_START | Host: start duel |
| 0x30 | CTOS_REQUEST_FIELD | Request field |

### STOC Protocols (24)

| ID | Protocol | Description |
|----|----------|-------------|
| 0x01 | STOC_GAME_MSG | Game message (wraps MSG protocol) |
| 0x02 | STOC_ERROR_MSG | Error message |
| 0x03 | STOC_SELECT_HAND | Select hand |
| 0x04 | STOC_SELECT_TP | Select turn player |
| 0x05 | STOC_HAND_RESULT | Hand result |
| 0x06 | STOC_TP_RESULT | Turn player result |
| 0x07 | STOC_CHANGE_SIDE | Change side |
| 0x08 | STOC_WAITING_SIDE | Waiting for side deck |
| 0x09 | STOC_DECK_COUNT | Deck count |
| 0x11 | STOC_CREATE_GAME | Game created |
| 0x12 | STOC_JOIN_GAME | Join game |
| 0x13 | STOC_TYPE_CHANGE | Type change |
| 0x14 | STOC_LEAVE_GAME | Leave game |
| 0x15 | STOC_DUEL_START | Duel start |
| 0x16 | STOC_DUEL_END | Duel end |
| 0x17 | STOC_REPLAY | Replay data (using ygopro-yrp-encode) |
| 0x18 | STOC_TIME_LIMIT | Time limit |
| 0x19 | STOC_CHAT | Chat message (variable length) |
| 0x20 | STOC_HS_PLAYER_ENTER | Host: player enter |
| 0x21 | STOC_HS_PLAYER_CHANGE | Host: player change |
| 0x22 | STOC_HS_WATCH_CHANGE | Host: watch change |
| 0x23 | STOC_TEAMMATE_SURRENDER | Teammate surrender |
| 0x30 | STOC_FIELD_FINISH | Field finish |
| 0x31 | STOC_SRVPRO_ROOMLIST | SRVPro room list |

### MSG Protocols (100+)

All YGOPro game messages are supported. See [MSG Protocol List](./CTOS_STOC_IMPLEMENTATION.md) for details.

**Response Support**: 18 MSG protocols require client responses. This library provides a unified response generation API with support for index-based and semantic object selection. See [MSG Response Guide](./MSG_RESPONSE_GUIDE.md) for details.

## Advanced Usage

### MSG Response Generation

18 MSG protocols require client responses (e.g., card selection, yes/no, position selection). This library provides two powerful methods for generating responses:

#### prepareResponse() - Generate Response Data

```typescript
import { 
  YGOProMsgSelectBattlecmd, 
  BattleCmdType,
  IndexResponse 
} from 'ygopro-msg-encode';

// Parse received MSG
const msg = new YGOProMsgSelectBattlecmd();
msg.fromPayload(msgData);

// Method 1: Index-based selection (explicit)
const response = msg.prepareResponse(
  BattleCmdType.ACTIVATE,
  IndexResponse(0) // Select first option
);

// Method 2: Semantic object selection (intelligent)
const response = msg.prepareResponse(
  BattleCmdType.ACTIVATE,
  { 
    code: 12345678,  // Card code
    location: 0x04,  // LOCATION_MZONE
    sequence: 2,     // Sequence number
    desc: 10         // Effect description (for multi-effect cards)
  }
);

// Send response
sendCtosResponse(response);
```

#### defaultResponse() - Conservative Default Behavior

Some messages support "do nothing" or conservative default responses:

```typescript
import { YGOProMsgSelectChain } from 'ygopro-msg-encode';

const msg = new YGOProMsgSelectChain();
msg.fromPayload(msgData);

// Get default response (if available)
const defaultResp = msg.defaultResponse();
if (defaultResp !== undefined) {
  // Use safe default (e.g., "no" for yes/no, cancel for optional selections)
  sendCtosResponse(defaultResp);
} else {
  // User input required
  promptUserForResponse(msg);
}
```

**Supported features:**
- ✅ Index-based selection with `IndexResponse(index)`
- ✅ Semantic object selection by card properties
- ✅ Partial matching (match only specified fields)
- ✅ Conservative default responses when available
- ✅ Automatic error detection (invalid index, card not found)
- ✅ Type-safe enums for command types

**See [MSG Response Guide](./MSG_RESPONSE_GUIDE.md) for complete documentation.**

### Special Protocols

#### CTOS_UPDATE_DECK

Uses `ygopro-deck-encode` library for deck encoding:

```typescript
import { YGOProCtosUpdateDeck } from 'ygopro-msg-encode';
import YGOProDeck from 'ygopro-deck-encode';

const updateDeck = new YGOProCtosUpdateDeck();
updateDeck.deck = new YGOProDeck({
  main: [12345, 67890],
  extra: [11111],
  side: [22222],
});

const payload = updateDeck.toFullPayload();
```

#### STOC_REPLAY

Uses `ygopro-yrp-encode` library for replay encoding:

```typescript
import { YGOProStocReplay } from 'ygopro-msg-encode';
import { YGOProYrp } from 'ygopro-yrp-encode';

const replay = new YGOProStocReplay();
replay.replay = new YGOProYrp({
  /* replay data */
});

const payload = replay.toFullPayload();
```

#### STOC_GAME_MSG

Wraps MSG protocol messages:

```typescript
import { YGOProStocGameMsg, YGOProMsgHint } from 'ygopro-msg-encode';

const gameMsg = new YGOProStocGameMsg();
const hint = new YGOProMsgHint();
hint.type = 1;
hint.player = 0;
hint.desc = 0x1234;
gameMsg.msg = hint;

const payload = gameMsg.toFullPayload();
```

### Variable-Length Strings

Three protocols use variable-length encoding for bandwidth optimization:

```typescript
import { YGOProCtosChat } from 'ygopro-msg-encode';

const chat = new YGOProCtosChat();
chat.msg = "Hi"; // Only 6 bytes instead of fixed 512 bytes!
const payload = chat.toFullPayload();
```

Protocols with variable-length strings:
- `CTOS_CHAT`
- `STOC_CHAT`
- `CTOS_EXTERNAL_ADDRESS`

### IPv4 Address Handling

`CTOS_EXTERNAL_ADDRESS` supports string-based IPv4 addresses:

```typescript
import { YGOProCtosExternalAddress } from 'ygopro-msg-encode';

const ext = new YGOProCtosExternalAddress();
ext.real_ip = "192.168.1.1";           // Standard IPv4
ext.real_ip = "::ffff:192.168.1.1";    // IPv6-mapped IPv4 (auto-converted)
ext.hostname = "example.com";

const payload = ext.toFullPayload();
```

The IP address is automatically converted to/from network byte order (big-endian).

### Room List (SRVPro)

```typescript
import { YGOProStocSrvproRoomlist, SrvproRoomInfo } from 'ygopro-msg-encode';

const roomlist = new YGOProStocSrvproRoomlist();
roomlist.count = 2;

const room1 = new SrvproRoomInfo();
room1.roomname = 'Room 1';
room1.room_status = 0; // Waiting
room1.player1 = 'Player A';
room1.player2 = 'Player B';

const room2 = new SrvproRoomInfo();
room2.roomname = 'Room 2';
room2.room_status = 1; // Dueling
room2.room_duel_count = 1;

roomlist.rooms = [room1, room2];

const payload = roomlist.toFullPayload();
```

## Performance

### Optimization Tips

#### ✅ Good Practices

```typescript
// 1. Reuse protocol instances
const protocol = new YGOProCtosChat();
for (const msg of messages) {
  protocol.msg = msg;
  send(protocol.toFullPayload());
}

// 2. Use try-catch for error handling
try {
  protocol.fromFullPayload(data);
} catch (error) {
  handleError(error);
}

// 3. Batch processing
const payloads = messages.map(msg => {
  const chat = new YGOProCtosChat();
  chat.msg = msg;
  return chat.toFullPayload();
});
```

#### ❌ Bad Practices

```typescript
// 1. Don't create new instances in loops
for (const msg of messages) {
  const protocol = new YGOProCtosChat(); // ❌ Wasteful
  protocol.msg = msg;
  send(protocol.toFullPayload());
}

// 2. Don't ignore errors
protocol.fromFullPayload(data); // ❌ No error handling

// 3. Don't mix APIs unnecessarily
const body = protocol.toPayload(); // ❌
const fullPayload = new Uint8Array(3 + body.length);
// ... manual header construction
// Use toFullPayload() instead!
```

## Testing

```bash
# Run all tests
npm test

# Run tests with coverage
npm test -- --coverage

# Run specific test suite
npm test ctos-stoc
```

## Building

```bash
# Build everything
npm run build

# Build specific format
npm run build:cjs    # CommonJS
npm run build:esm    # ES Modules
npm run build:types  # Type definitions

# Clean build output
npm run clean
```

## Documentation

- [Protocol Verification Summary](./PROTOCOL_VERIFICATION_SUMMARY.md) - **Complete protocol verification and fixes** 🔍
- [MSG Response Guide](./MSG_RESPONSE_GUIDE.md) - **Complete guide for MSG response generation** ⭐
- [Composite Fields Guide](./COMPOSITE_FIELDS_GUIDE.md) - Guide for bit-packed and composite fields
- [Composite Fields Audit](./COMPOSITE_FIELDS_AUDIT.md) - Complete audit of all composite fields
- [Composite Fields Refactor](./REFACTOR_COMPOSITE_FIELDS.md) - Latest API improvements (getter/setter, nested objects)
- [CTOS/STOC Implementation](./CTOS_STOC_IMPLEMENTATION.md) - Detailed protocol implementation
- [MSG Implementation](./MSG_IMPLEMENTATION_SUMMARY.md) - MSG protocol details
- [Full Payload API](./FULL_PAYLOAD_UPDATE.md) - `toFullPayload()` / `fromFullPayload()` documentation
- [Quick Reference](./QUICK_REFERENCE.md) - Quick API reference
- [Tests Migration](./TESTS_MIGRATION.md) - Testing guide

## Network Protocol Enums

This library provides TypeScript enums for network protocol fields with semantic meaning:

```typescript
import { 
  HandResult,           // Rock-paper-scissors result
  TurnPlayerResult,     // First/second turn selection
  NetPlayerType,        // Player position/type
  ChatColor,            // Chat message colors
  GameMode,             // Single/Match/Tag
  ErrorMessageType,     // Error message types
  RoomStatus,           // Room status (SRVPro)
} from 'ygopro-msg-encode';

// Example: Create a game with specific settings
const createGame = new YGOProCtosCreateGame();
createGame.info.mode = GameMode.MATCH;
createGame.info.rule = 0; // Rule index (0-5), maps to OT values in UI

// Example: Chat with color
const chat = new YGOProStocChat();
chat.player_type = ChatColor.RED; // Use color for system message
chat.msg = "Welcome to the game!";
```

**Note**: MSG protocol fields (like `phase`, `position`, `location`, `reason`) use constants from `OcgcoreCommonConstants` instead of enums, as they are automatically generated from YGOPro's `common.h`.

## Dependencies

- **Runtime Dependencies**:
  - `typed-reflector` - Decorator metadata support
  - `ygopro-deck-encode` - Deck encoding/decoding
  - `ygopro-yrp-encode` - Replay encoding/decoding

- **Development Dependencies**:
  - TypeScript, ESLint, Prettier
  - Jest for testing
  - esbuild for bundling

## Contributing

Contributions are welcome! Please follow these guidelines:

1. Fork the repository
2. Create a feature branch
3. Write tests for your changes
4. Ensure all tests pass (`npm test`)
5. Ensure code is properly formatted (`npm run lint`)
6. Submit a pull request

## License

MIT © [Nanahira](https://github.com/purerosefallen)

## Credits

- Based on [YGOPro](https://github.com/Fluorohydride/ygopro) protocol specifications
- Implements protocols from `ocgcore/network.h` and `gframe/duelclient.cpp`

## Support

- 🐛 [Report Issues](https://github.com/purerosefallen/ygopro-msg-encode/issues)
- 💬 [Discussions](https://github.com/purerosefallen/ygopro-msg-encode/discussions)
- 📧 Email: nanahira@momobako.com

## Related Projects

- [ygopro-deck-encode](https://github.com/purerosefallen/ygopro-deck-encode) - YGOPro deck encoding
- [ygopro-yrp-encode](https://github.com/purerosefallen/ygopro-yrp-encode) - YGOPro replay encoding
- [YGOPro](https://github.com/Fluorohydride/ygopro) - The original YGOPro client

---

Made with ❤️ for the YGOPro community
