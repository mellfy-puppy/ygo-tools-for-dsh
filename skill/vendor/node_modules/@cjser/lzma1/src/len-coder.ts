import {
	type BitTree,
	createBitTree,
	getBitPrice,
	initArray,
	initBitModels,
} from "./utils.js";

/**
 * Range encoder interface for LenEncoder to communicate with
 */
export interface RangeEncoder {
	encodeBit(probs: number[], index: number, symbol: number): void;
	encodeBitTree(encoder: BitTree, symbol: number): void;
}

/**
 * Length encoder class for LZMA compression
 * Handles encoding of match lengths with price optimization
 */
export class LenEncoder {
	// Choice probability arrays for length range selection
	private choice: number[] = initArray(2);

	// Low range coders (for lengths 2-9)
	private lowCoder: BitTree[] = [];

	// Mid range coders (for lengths 10-17)
	private midCoder: BitTree[] = [];

	// High range coder (for lengths 18+)
	private highCoder: BitTree = createBitTree(8);

	// Price optimization properties
	private tableSize: number = 0;
	private prices: number[] = [];
	private counters: number[] = [];

	constructor() {
		// Initialize low and mid coders for all position states (up to 16)
		for (let posState = 0; posState < 16; ++posState) {
			this.lowCoder[posState] = createBitTree(3);
			this.midCoder[posState] = createBitTree(3);
		}
	}

	/**
	 * Initialize the encoder with specified number of position states
	 */
	init(numPosStates: number): void {
		// Initialize choice probability models
		initBitModels(this.choice);

		// Initialize low and mid coders for each position state
		for (let posState = 0; posState < numPosStates; ++posState) {
			initBitModels(this.lowCoder[posState].models);
			initBitModels(this.midCoder[posState].models);
		}

		// Initialize high coder
		initBitModels(this.highCoder.models);
	}

	/**
	 * Encode a length value using the provided range encoder
	 */
	encode(symbol: number, posState: number, rangeEncoder: RangeEncoder): void {
		if (symbol < 8) {
			// Length 2-9: use low coder
			rangeEncoder.encodeBit(this.choice, 0, 0);
			rangeEncoder.encodeBitTree(this.lowCoder[posState], symbol);
		} else {
			symbol -= 8;
			rangeEncoder.encodeBit(this.choice, 0, 1);

			if (symbol < 8) {
				// Length 10-17: use mid coder
				rangeEncoder.encodeBit(this.choice, 1, 0);
				rangeEncoder.encodeBitTree(this.midCoder[posState], symbol);
			} else {
				// Length 18+: use high coder
				rangeEncoder.encodeBit(this.choice, 1, 1);
				rangeEncoder.encodeBitTree(this.highCoder, symbol - 8);
			}
		}
	}

	/**
	 * Encode with price table update
	 */
	encodeWithUpdate(symbol: number, posState: number, rangeEncoder: RangeEncoder): void {
		this.encode(symbol, posState, rangeEncoder);

		if (this.counters && (this.counters[posState] -= 1) == 0) {
			// Reset counter and update prices if needed
			this.counters[posState] = this.tableSize;
		}
	}

	/**
	 * Get price for encoding a symbol at the given position state
	 */
	getPrice(symbol: number, posState: number): number {
		return this.prices[posState * 0x110 + symbol];
	}

	/**
	 * Initialize as a price table encoder
	 */
	initPriceTable(): void {
		this.prices = [];
		this.counters = [];
	}

	/**
	 * Set table size for price optimization
	 */
	setTableSize(size: number): void {
		this.tableSize = size;
	}

	/**
	 * Set table size and update internal counters
	 */
	setTableSizeAndInitCounters(size: number, numPosStates: number): void {
		this.tableSize = size;
		if (this.counters) {
			for (let posState = 0; posState < numPosStates; ++posState) {
				this.counters[posState] = size;
			}
		}
	}

	/**
	 * Get table size
	 */
	getTableSize(): number {
		return this.tableSize;
	}

	/**
	 * Update price tables for all position states
	 */
	updateTables(numPosStates: number): void {
		if (!this.prices || !this.counters) {
			this.initPriceTable();
		}

		for (let posState = 0; posState < numPosStates; ++posState) {
			this.setPrices(
				posState,
				this.tableSize,
				this.prices,
				0,
			);

			if (this.counters) {
				this.counters[posState] = this.tableSize;
			}
		}
	}

	// Private methods for internal state management

	/**
	 * Calculate price for bit tree encoder
	 */
	private getBitTreePrice(encoder: BitTree, symbol: number): number {
		let bit, bitIndex, m = 1, price = 0;

		for (bitIndex = encoder.numBitLevels; bitIndex != 0;) {
			bitIndex -= 1;
			bit = symbol >>> bitIndex & 1;
			price += this.getBitPrice(encoder.models[m], bit);
			m = (m << 1) + bit;
		}

		return price;
	}

	/**
	 * Get price for a single bit
	 */
	private getBitPrice(prob: number, symbol: number): number {
		return getBitPrice(prob, symbol);
	}

	/**
	 * Set prices for all symbols in a position state range
	 */
	private setPrices(posState: number, numSymbols: number, prices: number[], priceIndex: number): void {
		const a0 = this.getBitPrice(this.choice[0], 0);
		const a1 = this.getBitPrice(this.choice[0], 1);
		const b0 = a1 + this.getBitPrice(this.choice[1], 0);
		const b1 = a1 + this.getBitPrice(this.choice[1], 1);

		let i = 0;
		const st = priceIndex + posState * 0x110;

		// Set prices for low range (lengths 2-9)
		for (i = 0; i < 8; ++i) {
			if (i >= numSymbols) return;
			prices[st + i] = a0 + this.getBitTreePrice(this.lowCoder[posState], i);
		}

		// Set prices for mid range (lengths 10-17)
		for (; i < 16; ++i) {
			if (i >= numSymbols) return;
			prices[st + i] = b0 + this.getBitTreePrice(this.midCoder[posState], i - 8);
		}

		// Set prices for high range (lengths 18+)
		for (; i < numSymbols; ++i) {
			prices[st + i] = b1 + this.getBitTreePrice(this.highCoder, i - 8 - 8);
		}
	}
}
