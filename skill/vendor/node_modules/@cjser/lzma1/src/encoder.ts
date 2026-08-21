import {
	LenEncoder,
	type RangeEncoder as LenRangeEncoder,
} from "./len-coder.js";
import { LitCoder } from "./lit-coder.js";
import { BinTreeMatchFinder } from "./match-finder.js";
import type {
	InputBuffer,
	OutputBuffer,
} from "./streams.js";
import type { LiteralDecoderEncoder2 } from "./utils.js";
import {
	type BitTree,
	createBitTree,
	G_FAST_POS,
	getBitPrice,
	getLenToPosState,
	INFINITY_PRICE,
	initArray,
	initBitModels,
	PROB_PRICES,
	stateUpdateChar,
} from "./utils.js";

const bitTreePriceCache = new Map<number, number>();

/**
 * Calculate price for direct bit encoding
 */
function getDirectBitsPrice(numBits: number): number {
	return numBits << 6;
}

/**
 * Get price for bit tree encoding with caching
 */
function getBitTreePrice(bitTree: BitTree, symbol: number): number {
	const cacheKey = (bitTree.numBitLevels << 16) | symbol;

	if (bitTreePriceCache.has(cacheKey)) {
		return bitTreePriceCache.get(cacheKey)!;
	}

	let price = 0;
	let modelIndex = 1;

	for (let bitIndex = bitTree.numBitLevels; bitIndex > 0; bitIndex--) {
		const bit = (symbol >>> (bitIndex - 1)) & 1;
		price += getBitPrice(bitTree.models[modelIndex], bit);
		modelIndex = (modelIndex << 1) + bit;
	}

	if (bitTreePriceCache.size < 10000) {
		bitTreePriceCache.set(cacheKey, price);
	}

	return price;
}

export interface Optimum {
	state?: number;
	price?: number;
	posPrev?: number;
	backPrev?: number;
	prev1IsChar?: number;
	prev2?: number;
	posPrev2?: number;
	backPrev2?: number;
	backs0?: number;
	backs1?: number;
	backs2?: number;
	backs3?: number;
}

interface RangeEncoder {
	stream: OutputBuffer | null;
	rrange: number;
	cache: number;
	low: bigint;
	cacheSize: number;
	position: bigint;
	encodeBit(probs: number[], index: number, bit: number): void;
	encodeBitTree(tree: BitTree, symbol: number): void;
	encodeDirectBits(value: number, bits: number): void;
}

/**
 * LZMA Encoder State - Encapsulates all encoder state management
 */
class EncoderState {
	// Core state
	public state: number = 0;
	public previousByte: number = 0;
	public position: bigint = 0n;

	// Repetition distances (LZ77 back-references)
	public repDistances: [number, number, number, number] = [0, 0, 0, 0];

	// Match finding state
	public longestMatchLength: number = 0;
	public longestMatchWasFound: boolean = false;
	public additionalOffset: number = 0;

	// Probability models for different encoding decisions
	public isMatch: number[] = initArray(0xC0);
	public isRep: number[] = initArray(0x0C);
	public isRepG0: number[] = initArray(0x0C);
	public isRepG1: number[] = initArray(0x0C);
	public isRepG2: number[] = initArray(0x0C);
	public isRep0Long: number[] = initArray(0xC0);

	/**
	 * Initialize all probability models to default values
	 */
	initModels(): void {
		initBitModels(this.isMatch);
		initBitModels(this.isRep);
		initBitModels(this.isRepG0);
		initBitModels(this.isRepG1);
		initBitModels(this.isRepG2);
		initBitModels(this.isRep0Long);
	}

	/**
	 * Update repetition distances when a new match is found
	 */
	updateRepDistances(newDistance: number, repIndex: number): void {
		if (repIndex === 0) {
			// New match becomes rep0, shift others
			this.repDistances[3] = this.repDistances[2];
			this.repDistances[2] = this.repDistances[1];
			this.repDistances[1] = this.repDistances[0];
			this.repDistances[0] = newDistance;
		} else {
			// Move specific rep to front, shift others
			const temp = this.repDistances[repIndex];
			for (let i = repIndex; i > 0; i--) {
				this.repDistances[i] = this.repDistances[i - 1];
			}
			this.repDistances[0] = temp;
		}
	}
}

/**
 * Position Encoder - Handles position slot and alignment encoding
 */
class PositionEncoder {
	private posSlotEncoder: BitTree[] = [];
	private posEncoders: number[] = initArray(0x72);
	private posAlignEncoder: BitTree;

	constructor() {
		// Initialize position slot encoders for different length states
		for (let lenState = 0; lenState < 4; lenState++) {
			this.posSlotEncoder[lenState] = createBitTree(6);
		}
		this.posAlignEncoder = createBitTree(4);
	}

	/**
	 * Initialize all position models
	 */
	init(): void {
		for (const encoder of this.posSlotEncoder) {
			initBitModels(encoder.models);
		}
		initBitModels(this.posEncoders);
		initBitModels(this.posAlignEncoder.models);
	}

	/**
	 * Encode position using optimal method
	 */
	encodePosition(
		distance: number,
		lenState: number,
		rangeEncoder: RangeEncoder,
	): void {
		const posSlot = this.getPosSlot(distance);
		rangeEncoder.encodeBitTree(this.posSlotEncoder[lenState], posSlot);

		if (posSlot >= 4) {
			const footerBits = (posSlot >> 1) - 1;
			const baseVal = (2 | (posSlot & 1)) << footerBits;
			const posReduced = distance - baseVal;

			if (posSlot < 14) {
				// Use position encoders for middle range
				this.encodeReverseBits(posReduced, footerBits, rangeEncoder);
			} else {
				// Use direct bits for high range + alignment
				rangeEncoder.encodeDirectBits(posReduced >> 4, footerBits - 4);
				rangeEncoder.encodeBitTree(this.posAlignEncoder, posReduced & 0x0F);
			}
		}
	}

	/**
	 * Calculate price for encoding a position
	 */
	getPositionPrice(distance: number, lenState: number): number {
		const posSlot = this.getPosSlot(distance);
		let price = getBitTreePrice(this.posSlotEncoder[lenState], posSlot);

		if (posSlot >= 4) {
			const footerBits = (posSlot >> 1) - 1;
			const baseVal = (2 | (posSlot & 1)) << footerBits;
			const posReduced = distance - baseVal;

			if (posSlot < 14) {
				price += this.getReverseBitsPrice(posReduced, footerBits);
			} else {
				price += getDirectBitsPrice(footerBits - 4);
				price += getBitTreePrice(this.posAlignEncoder, posReduced & 0x0F);
			}
		}

		return price;
	}

	private getPosSlot(distance: number): number {
		if (distance < 4) return distance;
		if (distance < (1 << (31 - 11))) {
			return G_FAST_POS[distance >> 6] + 12;
		}
		return G_FAST_POS[distance >> 26] + 52;
	}

	private encodeReverseBits(
		value: number,
		numBits: number,
		rangeEncoder: RangeEncoder,
	): void {
		let modelIndex = 1;
		for (let i = 0; i < numBits; i++) {
			const bit = value & 1;
			rangeEncoder.encodeBit(this.posEncoders, modelIndex, bit);
			modelIndex = (modelIndex << 1) | bit;
			value >>>= 1;
		}
	}

	private getReverseBitsPrice(value: number, numBits: number): number {
		let price = 0;
		let modelIndex = 1;
		for (let i = 0; i < numBits; i++) {
			const bit = value & 1;
			price += getBitPrice(this.posEncoders[modelIndex], bit);
			modelIndex = (modelIndex << 1) | bit;
			value >>>= 1;
		}
		return price;
	}
}

/**
 * LZMA Encoder class that handles compression operations
 */
export class Encoder implements LenRangeEncoder {
	private encoderState = new EncoderState();
	private positionEncoder = new PositionEncoder();

	// Core state properties
	_state: number = 0;
	_previousByte: number = 0;
	_distTableSize: number = 0;
	_longestMatchWasFound: number = 0;
	_optimumEndIndex: number = 0;
	_optimumCurrentIndex: number = 0;
	_additionalOffset: number = 0;

	// Dictionary and match finding
	_dictionarySize: number = 0;
	_matchFinder: BinTreeMatchFinder | null = null;
	_dictionarySizePrev: number = 0;
	_numFastBytes: number = 0;

	// Literal encoding configuration
	_numLiteralContextBits: number = 0;
	_numLiteralPosStateBits: number = 0;
	_posStateBits: number = 0;
	_posStateMask: number = 0;

	// Stream and processing state
	_needReleaseMFStream: number = 0;
	_inStream: InputBuffer | null = null;
	_finished: number = 0;
	nowPos64: bigint = 0n;

	// Distance and repetition arrays
	_repDistances: number[] = initArray(4);
	_optimum: Optimum[] = [];

	// Range encoder
	_rangeEncoder: RangeEncoder = {
		stream: null,
		rrange: 0,
		cache: 0,
		low: 0n,
		cacheSize: 0,
		position: 0n,
		encodeBit: () => {},
		encodeBitTree: () => {},
		encodeDirectBits: () => {},
	};

	// Bit model arrays for different types of encoding decisions
	_isMatch: number[] = initArray(0xC0);
	_isRep: number[] = initArray(0x0C);
	_isRepG0: number[] = initArray(0x0C);
	_isRepG1: number[] = initArray(0x0C);
	_isRepG2: number[] = initArray(0x0C);
	_isRep0Long: number[] = initArray(0xC0);

	// Position and alignment encoders
	_posSlotEncoder: BitTree[] = [];
	_posEncoders: number[] = initArray(0x72);
	_posAlignEncoder: BitTree | null = null;

	// Length encoders
	_lenEncoder: LenEncoder | null = null;
	_repMatchLenEncoder: LenEncoder | null = null;

	// Literal encoder
	_literalEncoder: LitCoder | null = null;

	// Distance and price arrays
	_matchDistances: number[] = [];
	_posSlotPrices: number[] = [];
	_distancesPrices: number[] = [];
	_alignPrices: number[] = initArray(0x10);
	_matchPriceCount: number = 0;
	_alignPriceCount: number = 0;

	// Optimization arrays
	reps: number[] = initArray(4);
	repLens: number[] = initArray(4);

	// Processing counters
	processedInSize: bigint[] = [0n];
	processedOutSize: bigint[] = [0n];
	finished: number[] = [0];
	properties = new Uint8Array(5);
	tempPrices: number[] = initArray(0x80); // 128

	// Match finding properties
	_longestMatchLength: number = 0;
	_matchFinderType: number = 1;
	_numDistancePairs: number = 0;
	_numFastBytesPrev: number = -1;
	backRes: number = 0;

	constructor() {
		// Encoder is initialized with default values above
		// Additional initialization will be done through specific init methods
	}

	/**
	 * Initialize basic encoder state
	 */
	baseInit(): void {
		this._state = 0;
		this._previousByte = 0;

		for (let i = 0; i < 4; ++i) {
			this._repDistances[i] = 0;
		}
	}

	/**
	 * Get optimum array
	 */
	getOptimum(): Optimum[] {
		return this._optimum;
	}

	/**
	 * Get back result
	 */
	getBackRes(): number {
		return this.backRes;
	}

	setBackRes(backRes: number): void {
		this.backRes = backRes;
	}

	init(): void {
		this.baseInit();

		this.encoderState.initModels();
		this.positionEncoder.init();

		// Initialize optimum array properly
		this._optimum = [];
		for (let i = 0; i < 0x1000; i++) {
			this._optimum[i] = {};
		}

		this.initEncoderState();
		initBitModels(this._isMatch);
		initBitModels(this._isRep0Long);
		initBitModels(this._isRep);
		initBitModels(this._isRepG0);
		initBitModels(this._isRepG1);
		initBitModels(this._isRepG2);
		initBitModels(this._posEncoders);

		this.initLiteralEncoder();
		for (let i = 0; i < 4; ++i) {
			initBitModels(this._posSlotEncoder[i].models);
		}

		if (this._lenEncoder) {
			this._lenEncoder.init(1 << this._posStateBits);
		}
		if (this._repMatchLenEncoder) {
			this._repMatchLenEncoder.init(1 << this._posStateBits);
		}
		if (this._posAlignEncoder) {
			initBitModels(this._posAlignEncoder.models);
		}

		this._longestMatchWasFound = 0;
		this._optimumEndIndex = 0;
		this._optimumCurrentIndex = 0;
		this._additionalOffset = 0;
	}

	/**
	 * Initialize encoder range coder
	 */
	initEncoderState(): void {
		this._rangeEncoder.low = 0n;
		this._rangeEncoder.rrange = 0xFFFFFFFF;
		this._rangeEncoder.cacheSize = 1;
		this._rangeEncoder.cache = 0;
		this._rangeEncoder.position = 0n;
	}

	/**
	 * Initialize literal encoder
	 */
	initLiteralEncoder(): void {
		const totalStates = 1 << (this._literalEncoder!.numPrevBits + this._literalEncoder!.numPosBits);

		for (let i = 0; i < totalStates; ++i) {
			initBitModels(this._literalEncoder!.coders[i].decoders);
		}
	}

	/**
	 * Create optimum structures
	 */
	createOptimumStructures(): void {
		for (let i = 0; i < 0x1000; ++i) {
			this._optimum[i] = {};
		}

		for (let i = 0; i < 4; ++i) {
			this._posSlotEncoder[i] = createBitTree(6);
		}
	}

	/**
	 * Create length price table encoder
	 */
	createLenPriceTableEncoder(): LenEncoder {
		const encoder = new LenEncoder();
		encoder.initPriceTable();
		return encoder;
	}

	/**
	 * Create literal encoder encoder2
	 */
	createLiteralEncoderEncoder2(): LiteralDecoderEncoder2 {
		const encoder = {
			decoders: initArray(0x300),
		} as LiteralDecoderEncoder2;

		return encoder;
	}

	/**
	 * Create literal encoder
	 */
	createLiteralEncoder(): void {
		// Check if we need to recreate the encoder
		if (
			this._literalEncoder != null
			&& this._literalEncoder.numPrevBits == this._numLiteralContextBits
			&& this._literalEncoder.numPosBits == this._numLiteralPosStateBits
		) {
			return;
		}

		// Replace #LZMA_Encoder_LiteralEncoder_Create with LitCoder instantiation
		this._literalEncoder = new LitCoder(
			this._numLiteralPosStateBits,
			this._numLiteralContextBits,
		);
	}

	/**
	 * Initialize completely with proper encoder state
	 */
	initialize(): void {
		// Initialize encoder structures first
		this._lenEncoder = this.createLenPriceTableEncoder();
		this._repMatchLenEncoder = this.createLenPriceTableEncoder();
		this._posAlignEncoder = createBitTree(0x04);

		// Initialize optimum array
		this._optimum = [];
		this.createOptimumStructures();

		// Create literal encoder
		this.createLiteralEncoder();

		// Now call init to set up the state
		this.init();
	}

	/**
	 * Configure encoder settings
	 */
	configure(mode: { searchDepth: number; filterStrength: number; modeIndex: number; }): void {
		this.setDictionarySize(0x1 << mode.searchDepth);
		this._numFastBytes = mode.filterStrength;
		this._matchFinderType = mode.modeIndex;

		// lc is always 3, lp is always 0, pb is always 2
		this._numLiteralContextBits = 0x3;
		this._numLiteralPosStateBits = 0x0;
		this._posStateBits = 0x2;
		this._posStateMask = 0x3;
	}

	/**
	 * Set dictionary size
	 */
	setDictionarySize(dictionarySize: number): void {
		this._dictionarySize = dictionarySize;

		let dicLogSize = 0;
		for (; dictionarySize > (1 << dicLogSize); ++dicLogSize);

		this._distTableSize = dicLogSize * 2;
	}

	/**
	 * Encode a bit using range coder
	 */
	encodeBit(probs: number[], index: number, symbol: number): void {
		const rangeEncoder = this._rangeEncoder;

		let newBound, prob = probs[index];
		newBound = (rangeEncoder.rrange >>> 11) * prob;

		if (!symbol) {
			rangeEncoder.rrange = newBound;
			probs[index] = prob + ((2048 - prob) >>> 5);
		} else {
			rangeEncoder.low += BigInt(newBound >>> 0);
			rangeEncoder.rrange -= newBound;
			probs[index] = prob - (prob >>> 5);
		}

		if (!(rangeEncoder.rrange & -0x1000000)) {
			rangeEncoder.rrange <<= 8;
			this.shiftLow();
		}
	}

	/**
	 * Encode bit tree
	 */
	encodeBitTree(encoder: BitTree, symbol: number): void {
		let bit, bitIndex, m = 1;

		for (bitIndex = encoder.numBitLevels; bitIndex != 0;) {
			bitIndex -= 1;
			bit = symbol >>> bitIndex & 1;
			this.encodeBit(encoder.models, m, bit);
			m = m << 1 | bit;
		}
	}

	/**
	 * Encode literal
	 */
	encodeLiteral(encoder: LiteralDecoderEncoder2, symbol: number): void {
		let bit, context = 1;

		for (let i = 7; i >= 0; --i) {
			bit = (symbol >> i) & 1;
			this.encodeBit(encoder.decoders, context, bit);
			context = context << 1 | bit;
		}
	}

	/**
	 * Encode matched literal
	 */
	encodeMatched(encoder: LiteralDecoderEncoder2, matchByte: number, symbol: number): void {
		let bit, matchBit, state, same = true, context = 1;

		for (let i = 7; i >= 0; --i) {
			bit = (symbol >> i) & 1;
			state = context;

			if (same) {
				matchBit = (matchByte >> i) & 1;
				state += (1 + matchBit) << 8;
				same = matchBit === bit;
			}

			this.encodeBit(encoder.decoders, state, bit);
			context = context << 1 | bit;
		}
	}

	/**
	 * Encode length using direct method calls
	 */
	encodeLength(encoder: LenEncoder, symbol: number, posState: number): void {
		encoder.encode(symbol, posState, this);
	}

	/**
	 * Encode direct bits
	 */
	encodeDirectBits(valueToEncode: number, numTotalBits: number): void {
		const rangeEncoder = this._rangeEncoder;

		for (let i = numTotalBits - 1; i >= 0; i -= 1) {
			rangeEncoder.rrange >>>= 1;
			if ((valueToEncode >>> i & 1) == 1) {
				rangeEncoder.low += BigInt(rangeEncoder.rrange >>> 0);
			}
			if (!(rangeEncoder.rrange & -0x1000000)) {
				rangeEncoder.rrange <<= 8;
				this.shiftLow();
			}
		}
	}

	/**
	 * Reverse encode
	 */
	reverseEncode(symbol: number): void {
		const posAlignEncoder = this._posAlignEncoder;
		if (!posAlignEncoder) return;

		let bit, m = 1;

		for (let i = 0; i < posAlignEncoder.numBitLevels; ++i) {
			bit = symbol & 1;
			this.encodeBit(posAlignEncoder.models, m, bit);
			m = m << 1 | bit;
			symbol >>= 1;
		}
	}

	/**
	 * Reverse encode range
	 */
	reverseEncodeRange(
		startIndex: number,
		numBitLevels: number,
		symbol: number,
	): void {
		let bit, m = 1;

		for (let i = 0; i < numBitLevels; ++i) {
			bit = symbol & 1;
			this.encodeBit(this._posEncoders, startIndex + m, bit);
			m = m << 1 | bit;
			symbol >>= 1;
		}
	}

	/**
	 * Write end marker
	 */
	writeEndMarker(positionState: number): void {
		this.encodeBit(
			this._isMatch,
			(this._state << 4) + positionState,
			1,
		);

		this.encodeBit(
			this._isRep,
			this._state,
			0,
		);

		this._state = this._state < 7 ? 7 : 10;
		this.encodeLength(this._lenEncoder!, 0, positionState);

		const posSlot = 63;
		const lenToPosState = getLenToPosState(2); // Length to position state for minimum length

		this.encodeBitTree(this._posSlotEncoder[lenToPosState], posSlot);

		this.encodeDirectBits(67108863, 26);
		this.reverseEncode(15);
	}

	/**
	 * Encode length with price table update
	 */
	encodeLengthWithPriceUpdate(encoder: LenEncoder, symbol: number, posState: number): void {
		encoder.encodeWithUpdate(symbol, posState, this);
	}

	/**
	 * Shift low helper (proper implementation) - public method for external access
	 */
	shiftLow(): void {
		const rangeEncoder = this._rangeEncoder;

		const lowHi = Number((rangeEncoder.low >> 32n) & 0xFFFFFFFFn);
		const lowLow = Number(rangeEncoder.low & 0xFFFFFFFFn);
		if (lowHi != 0 || lowLow < 0xFF000000) {
			rangeEncoder.position += BigInt(rangeEncoder.cacheSize);

			let temp = rangeEncoder.cache;
			do {
				this.writeToStream(rangeEncoder.stream, temp + lowHi);
				temp = 255;
			} while ((rangeEncoder.cacheSize -= 1) != 0);

			rangeEncoder.cache = (lowLow >>> 24) & 0xFF;
		}

		rangeEncoder.cacheSize += 1;
		rangeEncoder.low = BigInt(lowLow & 0xFFFFFF) << 8n;
	}

	/**
	 * Write byte to stream
	 */
	private writeToStream(stream: OutputBuffer | null, b: number): void {
		if (!stream) return;
		stream.writeByte(b << 24 >> 24);
	}

	initRangeEncoder(): void {
		this._rangeEncoder.position = 0n;
		this._rangeEncoder.low = 0n;
		this._rangeEncoder.rrange = -1;
		this._rangeEncoder.cacheSize = 1;
		this._rangeEncoder.cache = 0;
	}

	/**
	 * Fill alignment prices for position alignment encoder
	 */
	fillAlignPrices(): void {
		for (let i = 0; i < 16; ++i) {
			this._alignPrices[i] = this.reverseGetPrice(this._posAlignEncoder!, i);
		}
		this._alignPriceCount = 0;
	}

	/**
	 * Fill distance prices for position encoders
	 */
	fillDistancesPrices(): void {
		let baseVal, bitTreeEncoder: BitTree, footerBits, posSlot, st, st2;

		for (let i = 4; i < 0x80; ++i) {
			posSlot = this.getPosSlot(i);
			footerBits = (posSlot >> 1) - 1;
			baseVal = (2 | (posSlot & 1)) << footerBits;

			this.tempPrices[i] = this.reverseGetPriceArray(
				this._posEncoders,
				baseVal - posSlot - 1,
				footerBits,
				i - baseVal,
			);
		}

		for (let lenToPosState = 0; lenToPosState < 4; ++lenToPosState) {
			bitTreeEncoder = this._posSlotEncoder[lenToPosState];
			st = lenToPosState << 6;

			for (posSlot = 0; posSlot < this._distTableSize; posSlot += 1) {
				this._posSlotPrices[st + posSlot] = this.getEncoderBitTreePrice(bitTreeEncoder, posSlot);
			}

			for (posSlot = 14; posSlot < this._distTableSize; posSlot += 1) {
				this._posSlotPrices[st + posSlot] += (posSlot >> 1) - 1 - 4 << 6;
			}

			st2 = lenToPosState * 0x80;
			for (let i = 0; i < 4; ++i) {
				this._distancesPrices[st2 + i] = this._posSlotPrices[st + i];
			}

			for (let i = 4; i < 0x80; ++i) {
				this._distancesPrices[st2 + i] = this._posSlotPrices[st + this.getPosSlot(i)] + this.tempPrices[i];
			}
		}

		this._matchPriceCount = 0;
	}

	/**
	 * Get position slot for a distance value
	 */
	getPosSlot(pos: number): number {
		if (pos < 0x800) {
			return G_FAST_POS[pos];
		}

		if (pos < 0x200000) {
			return G_FAST_POS[pos >> 10] + 20;
		}

		return G_FAST_POS[pos >> 20] + 40;
	}

	/**
	 * Get reverse price for bit tree encoder
	 */
	reverseGetPrice(encoder: BitTree, symbol: number): number {
		let bit, m = 1, price = 0;

		for (let i = encoder.numBitLevels; i != 0; i -= 1) {
			bit = symbol & 1;
			symbol >>>= 1;
			price += this.getPrice(encoder.models[m], bit);
			m = m << 1 | bit;
		}

		return price;
	}

	/**
	 * Get reverse price for array of models
	 */
	reverseGetPriceArray(
		models: number[],
		startIndex: number,
		numBitLevels: number,
		symbol: number,
	): number {
		let bit, m = 1, price = 0;

		for (let i = numBitLevels; i != 0; i -= 1) {
			bit = symbol & 1;
			symbol >>>= 1;
			price += PROB_PRICES[((models[startIndex + m] - bit ^ -bit) & 2047) >>> 2];
			m = m << 1 | bit;
		}

		return price;
	}

	/**
	 * Get price for probability model (optimized)
	 */
	getPrice(prob: number, symbol: number): number {
		return getBitPrice(prob, symbol);
	}

	/**
	 * Get price for bit tree encoder
	 */
	getEncoderBitTreePrice(encoder: BitTree, symbol: number): number {
		return getBitTreePrice(encoder, symbol);
	}

	/**
	 * Create encoder optimization structures (optimized)
	 */
	createEncoderStructures(): void {
		// Pre-allocate optimum array with proper size
		// Initialize optimum array properly
		this._optimum = [];
		for (let i = 0; i < 0x1000; i++) {
			this._optimum[i] = {};
		}
		for (let i = 0; i < 0x1000; ++i) {
			this._optimum[i] = {};
		}

		// Initialize position slot encoders
		this._posSlotEncoder = new Array(4);
		for (let i = 0; i < 4; ++i) {
			this._posSlotEncoder[i] = createBitTree(6);
		}
	}

	/**
	 * Get literal encoder subcoder (utility method)
	 */
	getSubCoderUtility(pos: number, prevByte: number): LiteralDecoderEncoder2 {
		// Calculate position mask bits
		const posBits = pos & this._literalEncoder!.posMask;
		const posShifted = posBits << this._literalEncoder!.numPrevBits;

		// Calculate previous byte bits
		const prevByteShift = 0x08 - this._literalEncoder!.numPrevBits;
		const prevByteBits = (prevByte & 0xFF) >>> prevByteShift;

		// Combine position and prevByte bits to get final index
		const coderIndex = posShifted + prevByteBits;

		return this._literalEncoder!.coders[coderIndex];
	}

	// ── Encoding orchestration methods (moved from LZMA) ──

	private makeAsChar(optimum: Optimum): void {
		optimum.backPrev = -1;
		optimum.prev1IsChar = 0;
	}

	private makeAsShortRep(optimum: Optimum): void {
		optimum.backPrev = 0;
		optimum.prev1IsChar = 0;
	}

	private releaseMFStream(): void {
		if (this._matchFinder && this._needReleaseMFStream) {
			this._matchFinder._stream = null;
			this._needReleaseMFStream = 0;
		}
	}

	releaseStreams(): void {
		this.releaseMFStream();
		this._rangeEncoder.stream = null;
	}

	private getProcessedSizeAdd(): bigint {
		return BigInt(this._rangeEncoder.cacheSize) + this._rangeEncoder.position + 4n;
	}

	private getSubCoder(pos: number, prevByte: number): LiteralDecoderEncoder2 {
		const subCoder = this._literalEncoder!.getSubCoder(pos, prevByte);
		return { decoders: subCoder.decoders } as LiteralDecoderEncoder2;
	}

	private getLiteralPrice(
		encoder: LiteralDecoderEncoder2,
		matchMode: boolean,
		matchByte: number,
		symbol: number,
	): number {
		let bit, context = 1, i = 7, matchBit, price = 0;

		if (matchMode) {
			for (; i >= 0; --i) {
				matchBit = (matchByte >> i) & 1;
				bit = (symbol >> i) & 1;
				price += getBitPrice(
					encoder.decoders[((1 + matchBit) << 8) + context],
					bit,
				);
				context = context << 1 | bit;

				if (matchBit != bit) {
					--i;
					break;
				}
			}
		}

		for (; i >= 0; --i) {
			bit = symbol >> i & 1;
			price += getBitPrice(encoder.decoders[context], bit);
			context = context << 1 | bit;
		}

		return price;
	}

	private getPosLenPrice(
		pos: number,
		len: number,
		posState: number,
	): number {
		let price: number, lenToPosState = getLenToPosState(len);

		if (pos < 128) {
			price = this._distancesPrices[lenToPosState * 128 + pos];
		} else {
			const position = (lenToPosState << 6) + this.getPosSlot2(pos);
			price = this._posSlotPrices[position] + this._alignPrices[pos & 15];
		}

		return price + this._lenEncoder!.getPrice(len - 2, posState);
	}

	private getPureRepPrice(
		repIndex: number,
		state: number,
		posState: number,
	): number {
		let price;

		if (!repIndex) {
			price = PROB_PRICES[(this._isRepG0[state]) >>> 2];
			price += PROB_PRICES[
				0x800 - this._isRep0Long[(state << 4) + posState] >>> 2
			];
		} else {
			price = PROB_PRICES[(0x800 - this._isRepG0[state]) >>> 2];
			if (repIndex == 1) {
				price += PROB_PRICES[(this._isRepG1[state]) >>> 2];
			} else {
				price += PROB_PRICES[(0x800 - this._isRepG1[state]) >>> 2];
				price += getBitPrice(this._isRepG2[state], repIndex - 2);
			}
		}

		return price;
	}

	private getRepLen1Price(posState: number): number {
		const repG0Price = PROB_PRICES[(this._isRepG0[this._state]) >>> 2];
		const rep0LongPrice = PROB_PRICES[this._isRep0Long[(this._state << 4) + posState] >>> 2];
		return repG0Price + rep0LongPrice;
	}

	private getPosSlot2(pos: number): number {
		if (pos < 0x20000) {
			return G_FAST_POS[pos >> 6] + 12;
		}
		if (pos < 0x8000000) {
			return G_FAST_POS[pos >> 16] + 32;
		}
		return G_FAST_POS[pos >> 26] + 52;
	}

	private movePosHelper(num: number): void {
		if (num > 0) {
			this._matchFinder!.skip(num);
			this._additionalOffset += num;
		}
	}

	private readMatchDistances(): number {
		let lenRes = 0;
		this._numDistancePairs = this._matchFinder!.getMatches(this._matchDistances);

		if (this._numDistancePairs > 0) {
			lenRes = this._matchDistances[this._numDistancePairs - 2];

			if (lenRes == this._numFastBytes) {
				lenRes += this._matchFinder!.getMatchLen(
					lenRes - 1,
					this._matchDistances[this._numDistancePairs - 1],
					0x0111 - lenRes,
				);
			}
		}

		this._additionalOffset += 1;
		return lenRes;
	}

	private flushEncoding(nowPos: number): void {
		this.releaseMFStream();
		this.writeEndMarker(nowPos & this._posStateMask);
		for (let i = 0; i < 5; ++i) {
			this.shiftLow();
		}
	}

	private backward(cur: number): number {
		let backCur, backMem, posMem, posPrev;

		this._optimumEndIndex = cur;
		posMem = this._optimum[cur].posPrev;
		backMem = this._optimum[cur].backPrev;

		do {
			if (this._optimum[cur].prev1IsChar) {
				this.makeAsChar(this._optimum[posMem!]);
				this._optimum[posMem!].posPrev = posMem! - 1;

				if (this._optimum[cur].prev2) {
					this._optimum[posMem! - 1].prev1IsChar = 0;
					this._optimum[posMem! - 1].posPrev = this._optimum[cur].posPrev2;
					this._optimum[posMem! - 1].backPrev = this._optimum[cur].backPrev2;
				}
			}

			posPrev = posMem;
			backCur = backMem;
			backMem = this._optimum[posPrev!].backPrev;
			posMem = this._optimum[posPrev!].posPrev;
			this._optimum[posPrev!].backPrev = backCur;
			this._optimum[posPrev!].posPrev = cur;
			cur = posPrev!;
		} while (cur > 0);

		this.backRes = this._optimum[0].backPrev!;
		this._optimumCurrentIndex = this._optimum[0].posPrev!;
		return this._optimumCurrentIndex;
	}

	private getOptimumLength(position: number): number {
		let cur,
			curAnd1Price,
			curAndLenCharPrice,
			curAndLenPrice,
			curBack,
			curPrice,
			currentByte,
			distance,
			len,
			lenEnd,
			lenMain,
			lenTest,
			lenTest2,
			lenTestTemp,
			matchByte,
			matchPrice,
			newLen,
			nextIsChar,
			nextMatchPrice,
			nextOptimum,
			nextRepMatchPrice,
			normalMatchPrice,
			numAvailableBytes,
			numAvailableBytesFull,
			numDistancePairs,
			offs,
			offset,
			opt,
			optimum,
			pos,
			posPrev,
			posState,
			posStateNext,
			price_4,
			repIndex,
			repLen,
			repMatchPrice,
			repMaxIndex,
			shortRepPrice,
			startLen,
			state,
			state2,
			t,
			price,
			price_0,
			price_1,
			price_2,
			price_3,
			lenRes;

		if (this._optimumEndIndex != this._optimumCurrentIndex) {
			lenRes = this._optimum[this._optimumCurrentIndex].posPrev! - this._optimumCurrentIndex;
			this.backRes = this._optimum[this._optimumCurrentIndex].backPrev!;
			this._optimumCurrentIndex = this._optimum[this._optimumCurrentIndex].posPrev!;
			return lenRes;
		}

		this._optimumCurrentIndex = this._optimumEndIndex = 0;
		if (this._longestMatchWasFound) {
			lenMain = this._longestMatchLength;
			this._longestMatchWasFound = 0;
		} else {
			lenMain = this.readMatchDistances();
		}

		numDistancePairs = this._numDistancePairs;
		numAvailableBytes = this._matchFinder!.getNumAvailableBytes() + 1;

		if (numAvailableBytes < 2) {
			this.backRes = -1;
			return 1;
		}

		if (numAvailableBytes > 0x0111) {
			numAvailableBytes = 0x0111;
		}

		repMaxIndex = 0;
		for (let i = 0; i < 4; ++i) {
			this.reps[i] = this._repDistances[i];
			this.repLens[i] = this._matchFinder!.getMatchLen(-1, this.reps[i], 0x0111);

			if (this.repLens[i] > this.repLens[repMaxIndex]) {
				repMaxIndex = i;
			}
		}

		if (this.repLens[repMaxIndex] >= this._numFastBytes) {
			this.backRes = repMaxIndex;
			lenRes = this.repLens[repMaxIndex];
			this.movePosHelper(lenRes - 1);
			return lenRes;
		}

		if (lenMain >= this._numFastBytes) {
			this.backRes = this._matchDistances[numDistancePairs - 1] + 4;
			this.movePosHelper(lenMain - 1);
			return lenMain;
		}

		currentByte = this._matchFinder!.getIndexByte(-1);
		matchByte = this._matchFinder!.getIndexByte(-this._repDistances[0] - 1 - 1);

		if (lenMain < 2 && currentByte != matchByte && this.repLens[repMaxIndex] < 2) {
			this.backRes = -1;
			return 1;
		}

		this._optimum[0].state = this._state;
		posState = position & this._posStateMask;
		this._optimum[1].price = PROB_PRICES[
			(this._isMatch[(this._state << 4) + posState]) >>> 2
		] + this.getLiteralPrice(
			this.getSubCoder(position, this._previousByte),
			this._state >= 7,
			matchByte,
			currentByte,
		);

		this.makeAsChar(this._optimum[1]);
		matchPrice = PROB_PRICES[
			(2048 - this._isMatch[(this._state << 4) + posState])
			>>> 2
		];

		repMatchPrice = matchPrice + PROB_PRICES[
			(2048 - this._isRep[this._state]) >>> 2
		];

		if (matchByte == currentByte) {
			shortRepPrice = repMatchPrice + this.getRepLen1Price(posState);
			if (shortRepPrice < this._optimum[1].price!) {
				this._optimum[1].price = shortRepPrice;
				this.makeAsShortRep(this._optimum[1]);
			}
		}

		lenEnd = lenMain >= this.repLens[repMaxIndex]
			? lenMain
			: this.repLens[repMaxIndex];

		if (lenEnd < 2) {
			this.backRes = this._optimum[1].backPrev!;
			return 1;
		}

		this._optimum[1].posPrev = 0;
		this._optimum[0].backs0 = this.reps[0];
		this._optimum[0].backs1 = this.reps[1];
		this._optimum[0].backs2 = this.reps[2];
		this._optimum[0].backs3 = this.reps[3];
		len = lenEnd;

		do {
			this._optimum[len].price = INFINITY_PRICE;
			len -= 1;
		} while (len >= 2);

		for (let i = 0; i < 4; ++i) {
			repLen = this.repLens[i];
			if (repLen < 2) {
				continue;
			}
			price_4 = repMatchPrice + this.getPureRepPrice(
				i,
				this._state,
				posState,
			);

			do {
				curAndLenPrice = price_4 + this._repMatchLenEncoder!.getPrice(
					repLen - 2,
					posState,
				);
				optimum = this._optimum[repLen];
				if (curAndLenPrice < optimum.price!) {
					optimum.price = curAndLenPrice;
					optimum.posPrev = 0;
					optimum.backPrev = i;
					optimum.prev1IsChar = 0;
				}
			} while ((repLen -= 1) >= 2);
		}

		normalMatchPrice = matchPrice
			+ PROB_PRICES[(this._isRep[this._state]) >>> 2];

		len = this.repLens[0] >= 2 ? this.repLens[0] + 1 : 2;

		if (len <= lenMain) {
			offs = 0;
			while (len > this._matchDistances[offs]) {
				offs += 2;
			}

			for (;; len += 1) {
				distance = this._matchDistances[offs + 1];
				curAndLenPrice = normalMatchPrice + this.getPosLenPrice(distance, len, posState);
				optimum = this._optimum[len];

				if (curAndLenPrice < optimum.price!) {
					optimum.price = curAndLenPrice;
					optimum.posPrev = 0;
					optimum.backPrev = distance + 4;
					optimum.prev1IsChar = 0;
				}

				if (len == this._matchDistances[offs]) {
					offs += 2;
					if (offs == numDistancePairs) {
						break;
					}
				}
			}
		}
		cur = 0;

		while (1) {
			++cur;
			if (cur == lenEnd) {
				return this.backward(cur);
			}
			newLen = this.readMatchDistances();
			numDistancePairs = this._numDistancePairs;

			if (newLen >= this._numFastBytes) {
				this._longestMatchLength = newLen;
				this._longestMatchWasFound = 0x01;

				return this.backward(cur);
			}
			position += 0x01;
			posPrev = this._optimum[cur].posPrev;

			if (this._optimum[cur].prev1IsChar) {
				posPrev! -= 0x01;
				if (this._optimum[cur].prev2) {
					state = this._optimum[this._optimum[cur].posPrev2!].state;
					if (this._optimum[cur].backPrev2! < 0x04) {
						state = (state! < 0x07) ? 0x08 : 0x0B;
					} else {
						state = (state! < 0x07) ? 0x07 : 0x0A;
					}
				} else {
					state = this._optimum[posPrev!].state;
				}
				state = stateUpdateChar(state!);
			} else {
				state = this._optimum[posPrev!].state;
			}

			if (posPrev! == cur - 1) {
				if (!this._optimum[cur].backPrev) {
					state = state! < 7 ? 9 : 11;
				} else {
					state = stateUpdateChar(state!);
				}
			} else {
				if (
					this._optimum[cur].prev1IsChar
					&& this._optimum[cur].prev2
				) {
					posPrev = this._optimum[cur].posPrev2;
					pos = this._optimum[cur].backPrev2;
					state = state! < 0x07 ? 0x08 : 0x0B;
				} else {
					pos = this._optimum[cur].backPrev;
					if (pos! < 4) {
						state = state! < 0x07 ? 0x08 : 0x0B;
					} else {
						state = state! < 0x07 ? 0x07 : 0x0A;
					}
				}
				opt = this._optimum[posPrev!];

				if (pos! < 4) {
					if (!pos) {
						this.reps[0] = opt.backs0!;
						this.reps[1] = opt.backs1!;
						this.reps[2] = opt.backs2!;
						this.reps[3] = opt.backs3!;
					} else if (pos == 1) {
						this.reps[0] = opt.backs1!;
						this.reps[1] = opt.backs0!;
						this.reps[2] = opt.backs2!;
						this.reps[3] = opt.backs3!;
					} else if (pos == 2) {
						this.reps[0] = opt.backs2!;
						this.reps[1] = opt.backs0!;
						this.reps[2] = opt.backs1!;
						this.reps[3] = opt.backs3!;
					} else {
						this.reps[0] = opt.backs3!;
						this.reps[1] = opt.backs0!;
						this.reps[2] = opt.backs1!;
						this.reps[3] = opt.backs2!;
					}
				} else {
					this.reps[0] = pos! - 4;
					this.reps[1] = opt.backs0!;
					this.reps[2] = opt.backs1!;
					this.reps[3] = opt.backs2!;
				}
			}

			this._optimum[cur].state = state;
			this._optimum[cur].backs0 = this.reps[0];
			this._optimum[cur].backs1 = this.reps[1];
			this._optimum[cur].backs2 = this.reps[2];
			this._optimum[cur].backs3 = this.reps[3];
			curPrice = this._optimum[cur].price;

			currentByte = this._matchFinder!.getIndexByte(-0x01);
			matchByte = this._matchFinder!.getIndexByte(-this.reps[0] - 1 - 1);

			posState = position & this._posStateMask;
			curAnd1Price = curPrice!
				+ PROB_PRICES[(this._isMatch[(state! << 0x04) + posState]) >>> 2]
				+ this.getLiteralPrice(
					this.getSubCoder(position, this._matchFinder!.getIndexByte(-2)),
					state! >= 7,
					matchByte,
					currentByte,
				);

			nextOptimum = this._optimum[cur + 1];
			nextIsChar = 0;

			if (curAnd1Price < nextOptimum.price!) {
				nextOptimum.price = curAnd1Price;
				nextOptimum.posPrev = cur;
				nextOptimum.backPrev = -0x01;
				nextOptimum.prev1IsChar = 0;
				nextIsChar = 1;
			}

			matchPrice = curPrice! + PROB_PRICES[
				(2048 - this._isMatch[(state! << 4) + posState]) >>> 2
			];

			repMatchPrice = matchPrice + PROB_PRICES[(2048 - this._isRep[state!]) >>> 2];

			if (matchByte == currentByte && !(nextOptimum.posPrev! < cur && !nextOptimum.backPrev)) {
				shortRepPrice = repMatchPrice
					+ (PROB_PRICES[(this._isRepG0[state!]) >>> 0x02] + PROB_PRICES[(this._isRep0Long[(state! << 0x04) + posState]) >>> 0x02]);

				if (shortRepPrice <= nextOptimum.price!) {
					nextOptimum.price = shortRepPrice;
					nextOptimum.posPrev = cur;
					nextOptimum.backPrev = 0;
					nextOptimum.prev1IsChar = 0;
					nextIsChar = 1;
				}
			}

			numAvailableBytesFull = this._matchFinder!.getNumAvailableBytes() + 1;
			numAvailableBytesFull = 0xFFF - cur < numAvailableBytesFull
				? 0xFFF - cur
				: numAvailableBytesFull;

			numAvailableBytes = numAvailableBytesFull;

			if (numAvailableBytes < 2) {
				continue;
			}

			if (numAvailableBytes > this._numFastBytes) {
				numAvailableBytes = this._numFastBytes;
			}

			if (!nextIsChar && matchByte != currentByte) {
				t = Math.min(numAvailableBytesFull - 1, this._numFastBytes);
				lenTest2 = this._matchFinder!.getMatchLen(0, this.reps[0], t);

				if (lenTest2 >= 2) {
					state2 = stateUpdateChar(state);
					posStateNext = position + 1 & this._posStateMask;
					nextRepMatchPrice = curAnd1Price
						+ PROB_PRICES[(2048 - this._isMatch[(state2 << 4) + posStateNext]) >>> 2]
						+ PROB_PRICES[(2048 - this._isRep[state2]) >>> 2];

					offset = cur + 1 + lenTest2;

					while (lenEnd < offset) {
						this._optimum[lenEnd += 1].price = INFINITY_PRICE;
					}

					curAndLenPrice = nextRepMatchPrice + (price = this._repMatchLenEncoder!.getPrice(
						lenTest2 - 2,
						posStateNext,
					),
						price + this.getPureRepPrice(
							0,
							state2,
							posStateNext,
						));
					optimum = this._optimum[offset];

					if (curAndLenPrice < optimum.price!) {
						optimum.price = curAndLenPrice;
						optimum.posPrev = cur + 1;
						optimum.backPrev = 0;
						optimum.prev1IsChar = 1;
						optimum.prev2 = 0;
					}
				}
			}
			startLen = 0x02;

			for (repIndex = 0; repIndex < 4; ++repIndex) {
				lenTest = this._matchFinder!.getMatchLen(
					-0x01,
					this.reps[repIndex],
					numAvailableBytes,
				);

				if (lenTest < 2) {
					continue;
				}
				lenTestTemp = lenTest;

				do {
					while (lenEnd < cur + lenTest) {
						this._optimum[lenEnd += 1].price = INFINITY_PRICE;
					}

					curAndLenPrice = repMatchPrice + (price_0 = this._repMatchLenEncoder!.getPrice(
						lenTest - 2,
						posState,
					),
						price_0 + this.getPureRepPrice(
							repIndex,
							state,
							posState,
						));

					optimum = this._optimum[cur + lenTest];

					if (curAndLenPrice < optimum.price!) {
						optimum.price = curAndLenPrice;
						optimum.posPrev = cur;
						optimum.backPrev = repIndex;
						optimum.prev1IsChar = 0;
					}
				} while ((lenTest -= 1) >= 2);

				lenTest = lenTestTemp;

				if (!repIndex) {
					startLen = lenTest + 1;
				}

				if (lenTest < numAvailableBytesFull) {
					t = Math.min(
						numAvailableBytesFull - 1 - lenTest,
						this._numFastBytes,
					);
					lenTest2 = this._matchFinder!.getMatchLen(
						lenTest,
						this.reps[repIndex],
						t,
					);

					if (lenTest2 >= 2) {
						state2 = state < 7 ? 0x08 : 11;
						posStateNext = position + lenTest & this._posStateMask;
						curAndLenCharPrice = repMatchPrice
							+ (price_1 = this._repMatchLenEncoder!.getPrice(lenTest - 2, posState), price_1 + this.getPureRepPrice(repIndex, state, posState))
							+ PROB_PRICES[(this._isMatch[(state2 << 4) + posStateNext]) >>> 2]
							+ this.getLiteralPrice(
								this.getSubCoder(position + lenTest, this._matchFinder!.getIndexByte(lenTest - 1 - 1)),
								true,
								this._matchFinder!.getIndexByte(lenTest - 1 - (this.reps[repIndex] + 1)),
								this._matchFinder!.getIndexByte(lenTest - 1),
							);

						state2 = stateUpdateChar(state2);
						posStateNext = position + lenTest + 1 & this._posStateMask;

						nextMatchPrice = curAndLenCharPrice + PROB_PRICES[
							(2048 - this._isMatch[(state2 << 4) + posStateNext]) >>> 2
						];

						nextRepMatchPrice = nextMatchPrice + PROB_PRICES[
							(2048 - this._isRep[state2]) >>> 2
						];

						offset = lenTest + 1 + lenTest2;

						while (lenEnd < cur + offset) {
							this._optimum[lenEnd += 1].price = INFINITY_PRICE;
						}

						curAndLenPrice = nextRepMatchPrice + (price_2 = this._repMatchLenEncoder!.getPrice(lenTest2 - 2, posStateNext), price_2 + this.getPureRepPrice(0, state2, posStateNext));
						optimum = this._optimum[cur + offset];

						if (curAndLenPrice < optimum.price!) {
							optimum.price = curAndLenPrice;
							optimum.posPrev = cur + lenTest + 1;
							optimum.backPrev = 0;
							optimum.prev1IsChar = 1;
							optimum.prev2 = 1;
							optimum.posPrev2 = cur;
							optimum.backPrev2 = repIndex;
						}
					}
				}
			}

			if (newLen > numAvailableBytes) {
				newLen = numAvailableBytes;
				for (
					numDistancePairs = 0;
					newLen > this._matchDistances[numDistancePairs];
					numDistancePairs += 2
				) {}
				this._matchDistances[numDistancePairs] = newLen;
				numDistancePairs += 2;
			}

			if (newLen >= startLen) {
				normalMatchPrice = matchPrice + PROB_PRICES[(this._isRep[state]) >>> 2];

				while (lenEnd < cur + newLen) {
					this._optimum[lenEnd += 1].price = INFINITY_PRICE;
				}
				offs = 0;

				while (startLen > this._matchDistances[offs]) {
					offs += 2;
				}
				for (lenTest = startLen;; lenTest += 1) {
					curBack = this._matchDistances[offs + 1];
					curAndLenPrice = normalMatchPrice + this.getPosLenPrice(curBack, lenTest, posState);
					optimum = this._optimum[cur + lenTest];

					if (curAndLenPrice < optimum.price!) {
						optimum.price = curAndLenPrice;
						optimum.posPrev = cur;
						optimum.backPrev = curBack + 4;
						optimum.prev1IsChar = 0;
					}

					if (lenTest == this._matchDistances[offs]) {
						if (lenTest < numAvailableBytesFull) {
							t = Math.min(
								numAvailableBytesFull - 1 - lenTest,
								this._numFastBytes,
							);
							lenTest2 = this._matchFinder!.getMatchLen(
								lenTest,
								curBack,
								t,
							);

							if (lenTest2 >= 2) {
								state2 = state < 7 ? 7 : 10;
								posStateNext = position + lenTest & this._posStateMask;

								curAndLenCharPrice = curAndLenPrice
									+ PROB_PRICES[(this._isMatch[(state2 << 4) + posStateNext]) >>> 2]
									+ this.getLiteralPrice(
										this.getSubCoder(
											position + lenTest,
											this._matchFinder!.getIndexByte(lenTest - 1 - 1),
										),
										true,
										this._matchFinder!.getIndexByte(lenTest - (curBack + 1) - 1),
										this._matchFinder!.getIndexByte(lenTest - 1),
									);

								state2 = stateUpdateChar(state2);
								posStateNext = position + lenTest + 1 & this._posStateMask;

								nextMatchPrice = curAndLenCharPrice + PROB_PRICES[
									(2048 - this._isMatch[(state2 << 4) + posStateNext]) >>> 2
								];

								nextRepMatchPrice = nextMatchPrice + PROB_PRICES[
									(2048 - this._isRep[state2]) >>> 2
								];
								offset = lenTest + 1 + lenTest2;

								while (lenEnd < cur + offset) {
									this._optimum[lenEnd += 1].price = INFINITY_PRICE;
								}

								curAndLenPrice = nextRepMatchPrice + (price_3 = this._repMatchLenEncoder!.getPrice(lenTest2 - 2, posStateNext), price_3 + this.getPureRepPrice(0, state2, posStateNext));
								optimum = this._optimum[cur + offset];

								if (curAndLenPrice < optimum.price!) {
									optimum.price = curAndLenPrice;
									optimum.posPrev = cur + lenTest + 1;
									optimum.backPrev = 0;
									optimum.prev1IsChar = 1;
									optimum.prev2 = 1;
									optimum.posPrev2 = cur;
									optimum.backPrev2 = curBack + 4;
								}
							}
						}
						offs += 2;

						if (offs == numDistancePairs) {
							break;
						}
					}
				}
			}
		}

		// Fallback return - should not be reached in normal execution
		return 1;
	}

	codeOneBlock(): void {
		let baseVal,
			complexState,
			curByte,
			distance,
			footerBits,
			len,
			lenToPosState,
			matchByte,
			pos,
			posReduced,
			posSlot,
			posState,
			progressPosValuePrev,
			subCoder;

		this.processedInSize[0] = 0n;
		this.processedOutSize[0] = 0n;
		this.finished[0] = 1;
		progressPosValuePrev = this.nowPos64;

		if (this._inStream) {
			this._matchFinder!._stream = this._inStream;
			this._matchFinder!.init();
			this._needReleaseMFStream = 1;
			this._inStream = null;
		}

		if (this._finished) {
			return;
		}

		this._finished = 1;

		if (this.nowPos64 === 0n) {
			if (!this._matchFinder!.getNumAvailableBytes()) {
				this.flushEncoding(Number(this.nowPos64 & 0xFFFFFFFFn));
				return;
			}

			this.readMatchDistances();
			posState = Number(this.nowPos64 & 0xFFFFFFFFn) & this._posStateMask;

			this.encodeBit(
				this._isMatch,
				(this._state << 4) + posState,
				0,
			);

			this._state = stateUpdateChar(this._state);
			curByte = this._matchFinder!.getIndexByte(
				-this._additionalOffset,
			);

			this.encodeLiteral(
				this.getSubCoder(
					Number(this.nowPos64 & 0xFFFFFFFFn),
					this._previousByte,
				),
				curByte,
			);

			this._previousByte = curByte;
			this._additionalOffset -= 1;
			this.nowPos64 += 1n;
		}

		if (!this._matchFinder!.getNumAvailableBytes()) {
			this.flushEncoding(Number(this.nowPos64 & 0xFFFFFFFFn));
			return;
		}

		while (1) {
			len = this.getOptimumLength(Number(this.nowPos64 & 0xFFFFFFFFn));
			pos = this.backRes;
			posState = Number(this.nowPos64 & 0xFFFFFFFFn) & this._posStateMask;
			complexState = (this._state << 4) + posState;

			if (len == 1 && pos == -1) {
				this.encodeBit(
					this._isMatch,
					complexState,
					0,
				);

				curByte = this._matchFinder!.getIndexByte(
					-this._additionalOffset,
				);

				subCoder = this.getSubCoder(
					Number(this.nowPos64 & 0xFFFFFFFFn),
					this._previousByte,
				);

				if (this._state < 7) {
					this.encodeLiteral(subCoder, curByte);
				} else {
					matchByte = this._matchFinder!.getIndexByte(
						-this._repDistances[0]
							- 1
							- this._additionalOffset,
					);

					this.encodeMatched(
						subCoder,
						matchByte,
						curByte,
					);
				}
				this._previousByte = curByte;
				this._state = stateUpdateChar(this._state);
			} else {
				this.encodeBit(
					this._isMatch,
					complexState,
					1,
				);
				if (pos < 4) {
					this.encodeBit(
						this._isRep,
						this._state,
						1,
					);

					if (!pos) {
						this.encodeBit(
							this._isRepG0,
							this._state,
							0,
						);

						if (len == 1) {
							this.encodeBit(
								this._isRep0Long,
								complexState,
								0,
							);
						} else {
							this.encodeBit(
								this._isRep0Long,
								complexState,
								1,
							);
						}
					} else {
						this.encodeBit(
							this._isRepG0,
							this._state,
							1,
						);

						if (pos == 1) {
							this.encodeBit(
								this._isRepG1,
								this._state,
								0,
							);
						} else {
							this.encodeBit(
								this._isRepG1,
								this._state,
								1,
							);
							this.encodeBit(
								this._isRepG2,
								this._state,
								pos - 2,
							);
						}
					}

					if (len == 1) {
						this._state = this._state < 7 ? 9 : 11;
					} else {
						this.encodeLength(
							this._repMatchLenEncoder!,
							len - 2,
							posState,
						);
						this._state = this._state < 7
							? 0x08
							: 11;
					}
					distance = this._repDistances[pos];
					if (pos != 0) {
						for (let i = pos; i >= 1; --i) {
							this._repDistances[i] = this._repDistances[i - 1];
						}
						this._repDistances[0] = distance;
					}
				} else {
					this.encodeBit(
						this._isRep,
						this._state,
						0,
					);

					this._state = this._state < 7 ? 7 : 10;
					this.encodeLength(
						this._lenEncoder!,
						len - 0x02,
						posState,
					);

					pos -= 0x04;
					posSlot = this.getPosSlot(pos);
					lenToPosState = getLenToPosState(len);
					this.encodeBitTree(
						this._posSlotEncoder[lenToPosState],
						posSlot,
					);

					if (posSlot >= 0x04) {
						footerBits = (posSlot >> 0x01) - 0x01;
						baseVal = (0x02 | (posSlot & 0x01)) << footerBits;
						posReduced = pos - baseVal;

						if (posSlot < 0x0E) {
							this.reverseEncodeRange(
								baseVal - posSlot - 0x01,
								footerBits,
								posReduced,
							);
						} else {
							this.encodeDirectBits(posReduced >> 0x04, footerBits - 4);
							this.reverseEncode(posReduced & 0x0F);
							this._alignPriceCount += 1;
						}
					}
					distance = pos;
					for (let i = 3; i >= 1; --i) {
						this._repDistances[i] = this._repDistances[i - 1];
					}

					this._repDistances[0] = distance;
					this._matchPriceCount += 0x01;
				}

				this._previousByte = this._matchFinder!.getIndexByte(
					len - 1 - this._additionalOffset,
				);
			}

			this._additionalOffset -= len;
			this.nowPos64 += BigInt(len);

			if (!this._additionalOffset) {
				if (this._matchPriceCount >= 0x80) {
					this.fillDistancesPrices();
				}

				if (this._alignPriceCount >= 0x10) {
					this.fillAlignPrices();
				}

				this.processedInSize[0] = this.nowPos64;
				this.processedOutSize[0] = this.getProcessedSizeAdd();

				if (!this._matchFinder!.getNumAvailableBytes()) {
					this.flushEncoding(Number(this.nowPos64 & 0xFFFFFFFFn));

					return;
				}

				if (
					(this.nowPos64 - progressPosValuePrev) >= 0x1000n
				) {
					this._finished = 0;
					this.finished[0] = 0;

					return;
				}
			}
		}
	}

	createMatchFinder(): void {
		if (!this._matchFinder) {
			const binTree = new BinTreeMatchFinder();
			let numHashBytes = 4;

			if (!this._matchFinderType) {
				numHashBytes = 2;
			}

			binTree.setType(numHashBytes);
			this._matchFinder = binTree;
		}
		this.createLiteralEncoder();

		if (
			this._dictionarySize == this._dictionarySizePrev
			&& this._numFastBytesPrev == this._numFastBytes
		) {
			return;
		}

		this._matchFinder!.create(
			this._dictionarySize,
			this._numFastBytes,
			0x1000,
			0x0112,
		);

		this._dictionarySizePrev = this._dictionarySize;
		this._numFastBytesPrev = this._numFastBytes;
	}

	writeHeaderProperties(output: OutputBuffer): void {
		this.properties[0] = (
			(this._posStateBits * 5 + this._numLiteralPosStateBits) * 9 + this._numLiteralContextBits
		) & 0xFF;

		for (let byteIndex = 0; byteIndex < 4; byteIndex++) {
			this.properties[1 + byteIndex] = (
				this._dictionarySize >> (0x08 * byteIndex)
			) & 0xFF;
		}

		for (let i = 0; i < 5; i++) {
			output.writeByte(this.properties[i]);
		}
	}

	initCompression(
		input: InputBuffer,
		output: OutputBuffer,
		len: bigint,
		mode: { searchDepth: number; filterStrength: number; modeIndex: number; },
	): void {
		if (len < -1n) {
			throw new Error("invalid length " + len);
		}

		this.initialize();
		this.configure(mode);

		this.writeHeaderProperties(output);

		for (let i = 0; i < 64; i += 8) {
			output.writeByte(
				(Number((len >> BigInt(i)) & 0xFFn)) << 24 >> 24,
			);
		}

		this._needReleaseMFStream = 0;
		this._inStream = input;
		this._finished = 0;

		this.createMatchFinder();
		this._rangeEncoder.stream = output;
		this.init();

		this.fillDistancesPrices();
		this.fillAlignPrices();

		this._lenEncoder!.setTableSize(this._numFastBytes + 1 - 2);
		this._lenEncoder!.updateTables(1 << this._posStateBits);

		this._repMatchLenEncoder!.setTableSize(this._numFastBytes + 1 - 2);
		this._repMatchLenEncoder!.updateTables(1 << this._posStateBits);

		this.nowPos64 = 0n;
	}

	compress(
		input: InputBuffer,
		output: OutputBuffer,
		mode: { searchDepth: number; filterStrength: number; modeIndex: number; },
	): void {
		this.initCompression(input, output, BigInt(input.count), mode);

		do {
			this.codeOneBlock();
			if (this.finished[0]) {
				this.releaseStreams();
				break;
			}
		} while (true);
	}
}
