import { LzOutWindow } from "./lz-window.js";
import { RangeDecoder } from "./range-decoder.js";
import type {
	InputBuffer,
	OutputBuffer,
} from "./streams.js";
import {
	_MAX_UINT32,
	type BitTree,
	CHOICE_ARRAY_SIZE,
	createBitTree,
	DEFAULT_WINDOW_SIZE,
	getLenToPosState,
	initArray,
	initBitModels,
	LITERAL_DECODER_SIZE,
	MATCH_DECODERS_SIZE,
	POS_DECODERS_SIZE,
	REP_DECODERS_SIZE,
	stateUpdateChar,
} from "./utils.js";

// Decoder-specific interfaces (not shared with encoder-side LenEncoder/LitCoder
// which have private fields and different method signatures)
interface LenDecoder {
	choice: number[];
	lowCoder: BitTree[];
	midCoder: BitTree[];
	highCoder: BitTree;
	numPosStates: number;
}

interface LiteralCoder {
	coders: any[];
	numPrevBits: number;
	numPosBits: number;
	posMask: number;
	init?(): void;
}

export class Decoder {
	rangeDecoder: RangeDecoder;
	outWindow: LzOutWindow;

	// Decoder state
	state: number = 0;
	rep0: number = 0;
	rep1: number = 0;
	rep2: number = 0;
	rep3: number = 0;
	prevByte: number = 0;
	nowPos64: bigint = 0n;
	outSize: bigint = 0n;

	// Decoder configuration
	posStateMask: number = 0;
	dictSizeCheck: number = 0;

	// Probability models for different symbols
	matchDecoders: number[] = [];
	rep0LongDecoders: number[] = [];
	repDecoders: number[] = [];
	repG0Decoders: number[] = [];
	repG1Decoders: number[] = [];
	repG2Decoders: number[] = [];
	posDecoders: number[] = [];

	// Complex decoders
	literalDecoder: LiteralCoder;
	posSlotDecoders: BitTree[] = [];
	lenDecoder: LenDecoder;
	repLenDecoder: LenDecoder;
	posAlignDecoder: BitTree;

	// Alias for compatibility with LZMA class
	get literalCoder() {
		return this.literalDecoder;
	}

	constructor() {
		// Initialize range decoder
		this.rangeDecoder = new RangeDecoder();

		// Initialize output window using proper LzOutWindow
		this.outWindow = new LzOutWindow(null, DEFAULT_WINDOW_SIZE);

		// Initialize probability models
		this.matchDecoders = initArray(MATCH_DECODERS_SIZE);
		this.rep0LongDecoders = initArray(MATCH_DECODERS_SIZE);
		this.repDecoders = initArray(REP_DECODERS_SIZE);
		this.repG0Decoders = initArray(REP_DECODERS_SIZE);
		this.repG1Decoders = initArray(REP_DECODERS_SIZE);
		this.repG2Decoders = initArray(REP_DECODERS_SIZE);
		this.posDecoders = initArray(POS_DECODERS_SIZE);

		// Initialize literal decoder
		this.literalDecoder = {
			coders: [],
			numPrevBits: 0,
			numPosBits: 0,
			posMask: 0,
			init: () => this.initLiteralDecoder(),
		};

		// Initialize position slot decoders (4 different length-to-position states)
		for (let i = 0; i < 4; i++) {
			this.posSlotDecoders[i] = createBitTree(6);
		}

		// Initialize length decoders
		this.lenDecoder = this.createLenDecoder();
		this.repLenDecoder = this.createLenDecoder();

		// Initialize position alignment decoder
		this.posAlignDecoder = createBitTree(4);
	}

	/**
	 * Read LZMA header, configure decoder, and prepare for decompression.
	 */
	initDecompression(input: InputBuffer, output: OutputBuffer): void {
		// Read 5-byte header properties
		const properties: number[] = [];
		for (let i = 0; i < 5; ++i) {
			const r = input.readByte();
			if (r === -1) {
				throw new Error("truncated input");
			}
			properties[i] = r << 24 >> 24;
		}

		if (!this.setDecoderProperties(properties)) {
			throw new Error("corrupted input");
		}

		// Read 8-byte uncompressed length from header
		let outSize: bigint;
		{
			let value = 0n;
			for (let i = 0; i < 8; i++) {
				const r = input.readByte();
				if (r === -1) {
					throw new Error("truncated input");
				}
				value += BigInt(r & 0xFF) << BigInt(i * 8);
			}
			// Check for unknown size marker (all 0xFF bytes)
			if (value === 0xFFFFFFFFFFFFFFFFn) {
				outSize = -1n;
			} else if (value > BigInt(_MAX_UINT32)) {
				outSize = -1n;
			} else {
				outSize = value;
			}
		}

		// Set up range decoder and output window
		this.rangeDecoder.setStream(input);
		this.flush();
		this.outWindow.stream = null;
		this.outWindow.stream = output;

		// Initialize decoder state
		this.init();
		this.state = 0;
		this.rep0 = 0;
		this.rep1 = 0;
		this.rep2 = 0;
		this.rep3 = 0;
		this.outSize = outSize;
		this.nowPos64 = 0n;
		this.prevByte = 0;
	}

	/**
	 * Full decompression: read header, decode all chunks, flush and cleanup.
	 */
	decompress(input: InputBuffer, output: OutputBuffer): void {
		this.initDecompression(input, output);

		while (true) {
			const result = this.codeOneChunk();
			if (result === -1) {
				throw new Error("corrupted input");
			}

			const isOutputComplete = (this.outSize >= 0n)
				&& (this.nowPos64 >= this.outSize);

			if (result || isOutputComplete) {
				this.flush();
				this.cleanup();
				return;
			}
		}
	}

	createLenDecoder(): LenDecoder {
		const decoder = {
			choice: initArray(CHOICE_ARRAY_SIZE),
			lowCoder: [] as BitTree[],
			midCoder: [] as BitTree[],
			highCoder: createBitTree(0x08),
			numPosStates: 0,
		};

		return decoder;
	}

	setDecoderProperties(properties: number[]): boolean {
		if (properties.length < 5) {
			return false;
		}

		const lc = properties[0] % 9;
		const remainder = Math.floor(properties[0] / 9);
		const lp = remainder % 5;
		const pb = Math.floor(remainder / 5);

		if (pb > 4) {
			return false;
		}

		// Set literal decoder properties
		this.literalDecoder.numPrevBits = lc;
		this.literalDecoder.numPosBits = lp;
		this.literalDecoder.posMask = (1 << lp) - 1;

		// Set position state mask
		this.posStateMask = (1 << pb) - 1;

		// Calculate dictionary size from properties[1-4]
		let dictSize = 0;
		for (let i = 0; i < 4; i++) {
			// Treat bytes as unsigned (0-255) instead of signed (-128 to 127)
			const unsignedByte = properties[1 + i] & 0xFF;
			dictSize += unsignedByte << (i * 8);
		}

		// Set dictionary size and check value
		this.dictSizeCheck = Math.max(dictSize, 1);

		// Initialize output window
		if (dictSize > 0) {
			this.outWindow.windowSize = Math.max(dictSize, 4096);
			this.outWindow.buffer = new Uint8Array(this.outWindow.windowSize);
		}

		// Initialize literal decoder coders
		const numStates = 1 << (this.literalDecoder.numPrevBits + this.literalDecoder.numPosBits);
		this.literalDecoder.coders = [];
		for (let i = 0; i < numStates; i++) {
			this.literalDecoder.coders[i] = {
				decoders: initArray(LITERAL_DECODER_SIZE), // 0x300
			};
		}

		// Initialize length decoders
		this.lenDecoder.numPosStates = 1 << pb;
		this.repLenDecoder.numPosStates = 1 << pb;

		// Initialize low and mid coders for length decoders
		this.lenDecoder.lowCoder = [];
		this.lenDecoder.midCoder = [];
		this.repLenDecoder.lowCoder = [];
		this.repLenDecoder.midCoder = [];

		for (let posState = 0; posState < (1 << pb); posState++) {
			this.lenDecoder.lowCoder[posState] = createBitTree(3);
			this.lenDecoder.midCoder[posState] = createBitTree(3);
			this.repLenDecoder.lowCoder[posState] = createBitTree(3);
			this.repLenDecoder.midCoder[posState] = createBitTree(3);
		}

		return true;
	}

	// Methods that modify decoder state
	copyBlock(len: number): void {
		const outputWindow = this.outWindow;
		const distance = this.rep0;

		let pos = outputWindow.pos - distance - 1;

		if (pos < 0) {
			pos += outputWindow.windowSize;
		}

		for (; len != 0; len -= 1) {
			if (pos >= outputWindow.windowSize) {
				pos = 0;
			}
			outputWindow.buffer![outputWindow.pos] = outputWindow.buffer![pos];
			outputWindow.pos += 1;
			pos += 1;

			if (outputWindow.pos >= outputWindow.windowSize) {
				this.flush();
			}
		}
	}

	putByte(b: number): void {
		this.outWindow.buffer![this.outWindow.pos] = b;
		this.outWindow.pos += 1;

		if (this.outWindow.pos >= this.outWindow.windowSize) {
			this.flush();
		}
	}

	getByte(distance: number): number {
		const outputWindow = this.outWindow;

		let pos = outputWindow.pos - distance - 1;
		if (pos < 0) {
			pos += outputWindow.windowSize;
		}

		return outputWindow.buffer![pos];
	}

	getDecoder(pos: number, prevByte: number): any {
		// Calculate index based on position and previous byte
		const positionMask = pos & this.literalDecoder.posMask;
		const prevBitsMask = (prevByte & 0xFF) >>> (8 - this.literalDecoder.numPrevBits);
		const index = (positionMask << this.literalDecoder.numPrevBits) + prevBitsMask;

		// Return decoder at calculated index
		return this.literalDecoder.coders[index];
	}

	initLiteralDecoder(): void {
		let numStates = 1 << (this.literalDecoder.numPrevBits + this.literalDecoder.numPosBits);

		for (let i = 0; i < numStates; ++i) {
			// Initialize bit models for each coder
			for (let j = 0; j < this.literalDecoder.coders[i].decoders.length; j++) {
				this.literalDecoder.coders[i].decoders[j] = 1024;
			}
		}
	}

	init(): void {
		this.outWindow.streamPos = 0;
		this.outWindow.pos = 0;

		initBitModels(this.matchDecoders);
		initBitModels(this.rep0LongDecoders);
		initBitModels(this.repDecoders);
		initBitModels(this.repG0Decoders);
		initBitModels(this.repG1Decoders);
		initBitModels(this.repG2Decoders);
		initBitModels(this.posDecoders);

		this.initLiteralDecoder();

		for (let i = 0; i < 4; ++i) {
			initBitModels(this.posSlotDecoders[i].models);
		}

		this.initLenDecoder(this.lenDecoder);
		this.initLenDecoder(this.repLenDecoder);
		initBitModels(this.posAlignDecoder.models);
		this.initRangeDecoder();
	}

	initLenDecoder(decoder: LenDecoder): void {
		initBitModels(decoder.choice);

		for (let posState = 0; posState < decoder.numPosStates; ++posState) {
			initBitModels(decoder.lowCoder[posState].models);
			initBitModels(decoder.midCoder[posState].models);
		}

		initBitModels(decoder.highCoder.models);
	}

	outWindowReleaseStream(): void {
		this.flush();
		this.outWindow.stream = null;
	}

	decodeBit(probs: number[], index: number): 0 | 1 {
		return this.rangeDecoder.decodeBit(probs, index);
	}

	decodeDirectBits(numTotalBits: number): number {
		return this.rangeDecoder.decodeDirectBits(numTotalBits);
	}

	initRangeDecoder(): void {
		this.rangeDecoder.init();
	}

	rangeBitTreeDecoder(bitTree: BitTree): number {
		let bitIndex, m = 1;

		for (bitIndex = bitTree.numBitLevels; bitIndex != 0; bitIndex -= 1) {
			m = (m << 1) + this.decodeBit(bitTree.models, m);
		}

		return m - (1 << bitTree.numBitLevels);
	}

	reverseDecode(models: number[], startIndex: number, numBitLevels: number): number {
		let symbol = 0;

		for (let bitIndex = 0, m = 1, bit: number; bitIndex < numBitLevels; ++bitIndex) {
			bit = this.decodeBit(models, startIndex + m);
			m <<= 1;
			m += bit;
			symbol |= bit << bitIndex;
		}

		return symbol;
	}

	reverseDecodeAlignDecoder(): number {
		let symbol = 0;

		for (let m = 1, bitIndex = 0, bit: number; bitIndex < this.posAlignDecoder.numBitLevels; ++bitIndex) {
			bit = this.decodeBit(this.posAlignDecoder.models, m);
			m <<= 1;
			m += bit;
			symbol |= bit << bitIndex;
		}

		return symbol;
	}

	// Update the placeholder implementations with actual logic
	decodeNormalWithRangeDecoder(decoder: any): number {
		let symbol = 1;
		do {
			symbol = symbol << 1 | this.decodeBit(decoder.decoders, symbol);
		} while (symbol < 0x100);

		return symbol << 24 >> 24;
	}

	decodeWithMatchByteWithRangeDecoder(encoder: any, matchByte: number): number {
		let bit, matchBit, symbol = 1;
		do {
			matchBit = (matchByte >> 7) & 1;
			matchByte <<= 1;
			bit = this.decodeBit(encoder.decoders, ((1 + matchBit) << 8) + symbol);
			symbol = symbol << 1 | bit;

			if (matchBit != bit) {
				while (symbol < 0x100) {
					symbol = symbol << 1 | this.decodeBit(encoder.decoders, symbol);
				}
				break;
			}
		} while (symbol < 0x100);

		return symbol << 24 >> 24;
	}

	decodeLenWithRangeDecoder(decoder: LenDecoder, posState: number): number {
		if (!this.decodeBit(decoder.choice, 0)) {
			return this.rangeBitTreeDecoder(decoder.lowCoder[posState]);
		}

		let symbol = 0x08;

		if (!this.decodeBit(decoder.choice, 1)) {
			symbol += this.rangeBitTreeDecoder(decoder.midCoder[posState]);
		} else {
			symbol += 0x08 + this.rangeBitTreeDecoder(decoder.highCoder);
		}

		return symbol;
	}

	codeOneChunk(): 0 | 1 | -1 {
		let decoder2: any, distance: number, len: number, numDirectBits: number, positionSlot: number;

		let posState = Number(this.nowPos64 & 0xFFFFFFFFn) & this.posStateMask;

		if (!this.decodeBit(this.matchDecoders, (this.state << 4) + posState)) {
			decoder2 = this.getDecoder(Number(this.nowPos64 & 0xFFFFFFFFn), this.prevByte);

			if (this.state < 7) {
				this.prevByte = this.decodeNormalWithRangeDecoder(decoder2);
			} else {
				this.prevByte = this.decodeWithMatchByteWithRangeDecoder(decoder2, this.getByte(this.rep0));
			}

			this.putByte(this.prevByte);
			this.state = stateUpdateChar(this.state);
			this.nowPos64 += 1n;
		} else {
			if (this.decodeBit(this.repDecoders, this.state)) {
				len = 0;
				if (!this.decodeBit(this.repG0Decoders, this.state)) {
					if (!this.decodeBit(this.rep0LongDecoders, (this.state << 4) + posState)) {
						this.state = this.state < 7 ? 9 : 11;
						len = 1;
					}
				} else {
					if (!this.decodeBit(this.repG1Decoders, this.state)) {
						distance = this.rep1;
					} else {
						if (!this.decodeBit(this.repG2Decoders, this.state)) {
							distance = this.rep2;
						} else {
							distance = this.rep3;
							this.rep3 = this.rep2;
						}
						this.rep2 = this.rep1;
					}

					this.rep1 = this.rep0;
					this.rep0 = distance;
				}

				if (!len) {
					len = this.decodeLenWithRangeDecoder(this.repLenDecoder, posState) + 2;
					this.state = this.state < 7 ? 0x08 : 11;
				}
			} else {
				this.rep3 = this.rep2;
				this.rep2 = this.rep1;
				this.rep1 = this.rep0;

				len = 2 + this.decodeLenWithRangeDecoder(this.lenDecoder, posState);
				this.state = this.state < 7 ? 7 : 10;

				positionSlot = this.rangeBitTreeDecoder(this.posSlotDecoders[getLenToPosState(len)]);

				if (positionSlot >= 4) {
					numDirectBits = (positionSlot >> 1) - 1;
					this.rep0 = (2 | (positionSlot & 1)) << numDirectBits;

					if (positionSlot < 14) {
						this.rep0 += this.reverseDecode(
							this.posDecoders,
							this.rep0 - positionSlot - 1,
							numDirectBits,
						);
					} else {
						this.rep0 += this.decodeDirectBits(numDirectBits - 4) << 4;
						this.rep0 += this.reverseDecodeAlignDecoder();

						if (this.rep0 < 0) {
							if (this.rep0 == -1) {
								return 1;
							}
							return -1;
						}
					}
				} else {
					this.rep0 = positionSlot;
				}
			}

			if (BigInt(this.rep0) >= this.nowPos64 || this.rep0 >= this.dictSizeCheck) {
				return -1;
			}

			this.copyBlock(len);
			this.nowPos64 += BigInt(len);
			this.prevByte = this.getByte(0);
		}

		return 0;
	}

	writeToOutput(buffer: OutputBuffer, data: Uint8Array, offset: number, length: number): void {
		buffer.writeBytes(data, offset, length);
	}

	flush(): void {
		const size = this.outWindow.pos - this.outWindow.streamPos;

		if (!size) {
			return;
		}

		if (this.outWindow.stream && this.outWindow.buffer) {
			this.outWindow.stream.writeBytes(
				this.outWindow.buffer,
				this.outWindow.streamPos,
				size,
			);
		}

		if (this.outWindow.pos >= this.outWindow.windowSize) {
			this.outWindow.pos = 0;
		}

		this.outWindow.streamPos = this.outWindow.pos;
	}

	/**
	 * Cleanup decoder resources
	 */
	cleanup(): void {
		this.outWindow.stream = null;
		this.rangeDecoder.stream = null;
	}
}
