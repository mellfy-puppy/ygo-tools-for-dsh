import { Decoder } from "./decoder.js";
import { Encoder } from "./encoder.js";
import {
	InputBuffer,
	OutputBuffer,
} from "./streams.js";

interface Mode {
	searchDepth: number;
	filterStrength: number;
	modeIndex: number;
}

/**
 * LZMA compression mode levels (1-9)
 * Higher values provide better compression but are slower
 */
export type CompressionMode = keyof typeof MODES;

/**
 * Compression modes
 */
export const MODES = {
	1: { searchDepth: 0x10, filterStrength: 0x40, modeIndex: 0x00 },
	2: { searchDepth: 0x14, filterStrength: 0x40, modeIndex: 0x00 },
	3: { searchDepth: 0x13, filterStrength: 0x40, modeIndex: 0x01 },
	4: { searchDepth: 0x14, filterStrength: 0x40, modeIndex: 0x01 },
	5: { searchDepth: 0x15, filterStrength: 0x80, modeIndex: 0x01 },
	6: { searchDepth: 0x16, filterStrength: 0x80, modeIndex: 0x01 },
	7: { searchDepth: 0x17, filterStrength: 0x80, modeIndex: 0x01 },
	8: { searchDepth: 0x18, filterStrength: 0xFF, modeIndex: 0x01 },
	9: { searchDepth: 0x19, filterStrength: 0xFF, modeIndex: 0x01 },
} as const;

export class LZMA {
	#encoder = new Encoder();
	#decoder = new Decoder();

	public compress(
		data: Uint8Array | ArrayBuffer,
		mode: CompressionMode = 5,
	): Int8Array {
		const inputData = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
		const output = new OutputBuffer(Math.max(32, Math.ceil(inputData.length * 1.2)));
		const input = new InputBuffer(inputData);

		this.#encoder.compress(input, output, MODES[mode]);

		const result = output.toArray();
		return new Int8Array(result.buffer, result.byteOffset, result.byteLength);
	}

	public compressString(
		data: string,
		mode: CompressionMode = 5,
	): Int8Array {
		return this.compress(new Uint8Array(this.#encodeString(data)), mode);
	}

	public decompress(bytearray: Uint8Array | ArrayBuffer): Uint8Array {
		const inputData = bytearray instanceof ArrayBuffer ? new Uint8Array(bytearray) : bytearray;
		const output = new OutputBuffer(Math.max(32, inputData.length * 2));
		const input = new InputBuffer(inputData);

		this.#decoder.decompress(input, output);

		return output.toArray();
	}

	public decompressString(bytearray: Uint8Array | ArrayBuffer): string {
		const decodedByteArray = this.decompress(bytearray);
		const result = this.#decodeUTF8(decodedByteArray);

		if (typeof result === "string") {
			return result;
		}
		return String.fromCharCode(...result);
	}

	#encodeString(inputString: string): number[] {
		const l = inputString.length;
		const chars: number[] = [];
		for (let i = 0; i < l; ++i) {
			chars[i] = inputString.charCodeAt(i);
		}

		const data: number[] = [];
		let elen = 0;
		for (let i = 0; i < l; ++i) {
			const ch = chars[i];
			if (ch >= 1 && ch <= 0x7F) {
				data[elen++] = ch << 24 >> 24;
			} else if (!ch || ch >= 0x80 && ch <= 0x7FF) {
				data[elen++] = (0xC0 | ch >> 6 & 0x1F) << 24 >> 24;
				data[elen++] = (0x80 | ch & 0x3F) << 24 >> 24;
			} else {
				data[elen++] = (0xE0 | ch >> 12 & 0x0F) << 24 >> 24;
				data[elen++] = (0x80 | ch >> 6 & 0x3F) << 24 >> 24;
				data[elen++] = (0x80 | ch & 0x3F) << 24 >> 24;
			}
		}

		return data;
	}

	#decodeUTF8(utf: Uint8Array): string | Uint8Array {
		let j = 0, x, y, z, l = utf.length, buf: string[] = [], charCodes: number[] = [];

		for (let i = 0; i < l; ++i, ++j) {
			x = utf[i] & 0xFF;
			if (!(x & 0x80)) {
				if (!x) return utf;
				charCodes[j] = x;
			} else if ((x & 0xE0) == 0xC0) {
				if (i + 1 >= l) return String.fromCharCode(...utf);
				y = utf[++i] & 0xFF;
				if ((y & 0xC0) != 0x80) return String.fromCharCode(...utf);
				charCodes[j] = ((x & 0x1F) << 6) | (y & 0x3F);
			} else if ((x & 0xF0) == 0xE0) {
				if (i + 2 >= l) return utf;
				y = utf[++i] & 0xFF;
				if ((y & 0xC0) != 0x80) return utf;
				z = utf[++i] & 0xFF;
				if ((z & 0xC0) != 0x80) return utf;
				charCodes[j] = ((x & 0x0F) << 0x0C) | ((y & 0x3F) << 6) | (z & 0x3F);
			} else {
				return utf;
			}
			if (j == 0x3FFF) {
				buf.push(String.fromCharCode.apply(String, charCodes));
				j = -1;
			}
		}

		if (j > 0) {
			charCodes.length = j;
			buf.push(String.fromCharCode.apply(String, charCodes));
		}

		return buf.join("");
	}
}
