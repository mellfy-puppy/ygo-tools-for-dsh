import {
	type BasicRangeDecoder,
	type BasicRangeEncoder,
	getBitPrice,
	initArray,
} from "./utils.js";

export class LitSubCoder {
	private coders: number[];

	constructor() {
		this.coders = initArray(0x300, 0x400);
	}

	/**
	 * Decode normal literal symbol
	 */
	decodeNormal(rd: BasicRangeDecoder): number {
		let symbol = 1;
		while (symbol < 0x100) {
			const i = rd.decodeBit(this.coders, symbol);
			symbol = (symbol << 1) | i;
		}
		return symbol & 0xFF;
	}

	/**
	 * Decode literal symbol with match byte context
	 */
	decodeWithMatchByte(rd: BasicRangeDecoder, matchByte: number): number {
		let uMatchByte = matchByte;
		let symbol = 1;

		while (symbol < 0x100) {
			const matchBit = (uMatchByte >> 7) & 1;
			uMatchByte <<= 1;
			const bit = rd.decodeBit(this.coders, ((1 + matchBit) << 8) + symbol);
			symbol = (symbol << 1) | bit;

			if (matchBit !== bit) {
				while (symbol < 0x100) {
					const i = rd.decodeBit(this.coders, symbol);
					symbol = (symbol << 1) | i;
				}
				break;
			}
		}
		return symbol & 0xFF;
	}

	/**
	 * Encode literal symbol
	 */
	encode(re: BasicRangeEncoder, symbol: number): void {
		let context = 1;
		for (let i = 7; i >= 0; i--) {
			const bit = (symbol >> i) & 1;
			re.encodeBit(this.coders, context, bit);
			context = (context << 1) | bit;
		}
	}

	/**
	 * Encode literal symbol with match byte context
	 */
	encodeMatched(re: BasicRangeEncoder, matchByte: number, symbol: number): void {
		let uMatchByte = matchByte;
		let context = 1;
		let same = true;

		for (let i = 7; i >= 0; i--) {
			const bit = (symbol >> i) & 1;
			let state = context;

			if (same) {
				const matchBit = (uMatchByte >> i) & 1;
				state += (1 + matchBit) << 8;
				same = matchBit === bit;
			}

			re.encodeBit(this.coders, state, bit);
			context = (context << 1) | bit;
		}
	}

	/**
	 * Get price for encoding literal symbol
	 */
	getPrice(matchMode: boolean, matchByte: number, symbol: number): number {
		let uMatchByte = matchByte;
		let price = 0;
		let context = 1;
		let i = 7;

		if (matchMode) {
			while (i >= 0) {
				const matchBit = (uMatchByte >> i) & 1;
				const bit = (symbol >> i) & 1;
				price += getBitPrice(this.coders[(1 + matchBit) << 8 + context], bit);
				context = (context << 1) | bit;

				if (matchBit !== bit) {
					i--;
					break;
				}
				i--;
			}
		}

		while (i >= 0) {
			const bit = (symbol >> i) & 1;
			price += getBitPrice(this.coders[context], bit);
			context = (context << 1) | bit;
			i--;
		}

		return price;
	}

	/**
	 * Reset coder to initial state
	 */
	reset(): void {
		this.coders.fill(1024);
	}

	/**
	 * Get decoders array (for compatibility with LiteralDecoderEncoder2)
	 */
	get decoders(): number[] {
		return this.coders;
	}
}

export class LitCoder {
	private _coders: LitSubCoder[];
	private _numPrevBits: number;
	private _posMask: number;

	constructor(numPosBits: number, numPrevBits: number) {
		const numStates = 1 << (numPrevBits + numPosBits);
		this._coders = [];
		this._numPrevBits = numPrevBits;
		this._posMask = (1 << numPosBits) - 1;

		for (let i = 0; i < numStates; i++) {
			this._coders[i] = new LitSubCoder();
		}
	}

	/**
	 * Get sub-coder for position and previous byte
	 */
	getSubCoder(pos: number, prevByte: number): LitSubCoder {
		return this._coders[
			((pos & this._posMask) << this._numPrevBits)
			+ (prevByte >> (8 - this._numPrevBits))
		];
	}

	/**
	 * Reset all sub-coders
	 */
	reset(): void {
		this._coders.forEach((coder) => coder.reset());
	}

	/**
	 * Get number of previous bits (for compatibility)
	 */
	get numPrevBits(): number {
		return this._numPrevBits;
	}

	/**
	 * Get number of position bits (for compatibility)
	 */
	get numPosBits(): number {
		// Calculate from posMask
		return Math.log2(this._posMask + 1);
	}

	/**
	 * Get position mask (for compatibility)
	 */
	get posMask(): number {
		return this._posMask;
	}

	/**
	 * Get coders array (for compatibility)
	 */
	get coders(): LitSubCoder[] {
		return this._coders;
	}
}
