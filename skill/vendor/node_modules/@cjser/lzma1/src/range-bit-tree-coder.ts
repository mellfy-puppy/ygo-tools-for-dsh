import {
	type BasicRangeDecoder,
	type BasicRangeEncoder,
	getBitPrice,
	initArray,
} from "./utils.js";

export class RangeBitTreeCoder {
	private models: number[];
	private numBitLevels: number;

	constructor(numBitLevels: number) {
		this.numBitLevels = numBitLevels;
		this.models = initArray(1 << numBitLevels, 1024); // Initialize with default probability
	}

	/**
	 * Decode symbol using range decoder
	 */
	decode(rd: BasicRangeDecoder): number {
		let res = 1;
		for (let bitIndex = this.numBitLevels; bitIndex !== 0; bitIndex--) {
			const bit = rd.decodeBit(this.models, res);
			res = (res << 1) + bit;
		}
		res -= 1 << this.numBitLevels;
		return res;
	}

	/**
	 * Reverse decode symbol using range decoder
	 */
	reverseDecode(rd: BasicRangeDecoder): number {
		let index = 1;
		let res = 0;
		for (let bitIndex = 0; bitIndex < this.numBitLevels; bitIndex++) {
			const bit = rd.decodeBit(this.models, index);
			index <<= 1;
			index += bit;
			res |= bit << bitIndex;
		}
		return res;
	}

	/**
	 * Encode symbol using range encoder
	 */
	encode(re: BasicRangeEncoder, symbol: number): void {
		let m = 1;
		for (let bitIndex = this.numBitLevels; bitIndex !== 0;) {
			bitIndex--;
			const bit = (symbol >> bitIndex) & 1;
			re.encodeBit(this.models, m, bit);
			m = (m << 1) | bit;
		}
	}

	/**
	 * Reverse encode symbol using range encoder
	 */
	reverseEncode(re: BasicRangeEncoder, symbol: number): void {
		let m = 1;
		for (let i = 0; i < this.numBitLevels; i++) {
			const bit = symbol & 1;
			re.encodeBit(this.models, m, bit);
			m = (m << 1) | bit;
			symbol >>= 1;
		}
	}

	/**
	 * Get price for encoding symbol
	 */
	getPrice(symbol: number): number {
		let res = 0;
		let m = 1;
		for (let bitIndex = this.numBitLevels; bitIndex !== 0;) {
			bitIndex--;
			const bit = (symbol >> bitIndex) & 1;
			res += getBitPrice(this.models[m], bit);
			m = (m << 1) + bit;
		}
		return res;
	}

	/**
	 * Get price for reverse encoding symbol
	 */
	reverseGetPrice(symbol: number): number {
		let res = 0;
		let m = 1;
		for (let i = this.numBitLevels; i !== 0; i--) {
			const bit = symbol & 1;
			symbol >>= 1;
			res += getBitPrice(this.models[m], bit);
			m = (m << 1) | bit;
		}
		return res;
	}

	/**
	 * Reset models to initial state
	 */
	reset(): void {
		for (let i = 0; i < this.models.length; i++) {
			this.models[i] = 1024; // Default probability
		}
	}
}
