import type { OutputBuffer } from "./streams.js";

export class RangeEncoder {
	private stream: OutputBuffer | null = null;
	private low: bigint = 0n;
	private rrange: number = 0;
	private cache: number = 0;
	private cacheSize: number = 0;
	private position: bigint = 0n;

	constructor() {
		// Initialize with default values
	}

	/**
	 * Set output stream for encoding
	 */
	setStream(stream: OutputBuffer | null): void {
		this.stream = stream;
	}

	/**
	 * Initialize range encoder
	 */
	init(): void {
		this.position = 0n;
		this.low = 0n;
		this.rrange = -1;
		this.cacheSize = 1;
		this.cache = 0;
	}

	/**
	 * Encode a single bit using probability model
	 */
	encodeBit(probs: number[], index: number, bit: number): void {
		const prob = probs[index];
		const newBound = (this.rrange >>> 11) * prob;

		if (bit === 0) {
			this.rrange = newBound;
			probs[index] = prob + ((2048 - prob) >>> 5);
		} else {
			this.low += BigInt(newBound);
			this.rrange -= newBound;
			probs[index] = prob - (prob >>> 5);
		}

		if (!(this.rrange & -0x1000000)) {
			this.rrange <<= 8;
			this.shiftLow();
		}
	}

	/**
	 * Encode direct bits (without probability model)
	 */
	encodeDirectBits(value: number, numTotalBits: number): void {
		for (let i = numTotalBits - 1; i >= 0; i--) {
			this.rrange >>>= 1;
			if (((value >>> i) & 1) === 1) {
				this.low += BigInt(this.rrange);
			}
			if (!(this.rrange & -0x1000000)) {
				this.rrange <<= 8;
				this.shiftLow();
			}
		}
	}

	/**
	 * Encode bit tree symbol
	 */
	encodeBitTree(numBitLevels: number, models: number[], symbol: number, startIndex: number = 1): void {
		let m = 1;
		for (let bitIndex = numBitLevels; bitIndex !== 0; bitIndex--) {
			const bit = (symbol >>> (bitIndex - 1)) & 1;
			this.encodeBit(models, startIndex + m - 1, bit);
			m = (m << 1) | bit;
		}
	}

	/**
	 * Reverse encode bits
	 */
	reverseEncodeBits(numBitLevels: number, models: number[], symbol: number, startIndex: number): void {
		let m = 1;
		for (let i = 0; i < numBitLevels; i++) {
			const bit = symbol & 1;
			this.encodeBit(models, startIndex + m, bit);
			m = (m << 1) | bit;
			symbol >>>= 1;
		}
	}

	/**
	 * Finish encoding and flush remaining data
	 */
	finish(): void {
		for (let i = 0; i < 5; i++) {
			this.shiftLow();
		}
	}

	/**
	 * Shift low value and write to stream
	 */
	private shiftLow(): void {
		const lowHi = Number((this.low >> 32n) & 0xFFFFFFFFn);

		if (lowHi !== 0 || Number(this.low & 0xFFFFFFFFn) < 0xFF000000) {
			this.position += BigInt(this.cacheSize);

			let temp = this.cache;
			do {
				this.writeToStream(temp + lowHi);
				temp = 255;
			} while (--this.cacheSize !== 0);

			this.cache = (Number(this.low & 0xFFFFFFFFn) >>> 24) & 0xFF;
		}

		this.cacheSize++;
		this.low = BigInt(Number(this.low & 0xFFFFFFFFn) & 0xFFFFFF) << 8n;
	}

	/**
	 * Write byte to output stream
	 */
	private writeToStream(value: number): void {
		if (!this.stream) {
			return;
		}
		this.stream.writeByte(value & 0xFF);
	}
}
