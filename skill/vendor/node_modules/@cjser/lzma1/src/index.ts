/**
 * @license
 * Copyright Filip Seman
 * SPDX-License-Identifier: MIT
 */

import {
	type CompressionMode,
	LZMA,
} from "./lzma.js";

export type { CompressionMode } from "./lzma.js";
export { CRC32_TABLE } from "./utils.js";

/**
 * Compresses data using LZMA algorithm
 *
 * @param data Data to compress - can be Uint8Array or ArrayBuffer
 * @param mode Compression mode (1-9), defaults to 5
 * @returns Compressed data as a byte array
 */
export function compress(
	data: Uint8Array | ArrayBuffer,
	mode: CompressionMode = 5,
): Uint8Array {
	// Convert ArrayBuffer to Uint8Array if needed
	const input = data instanceof ArrayBuffer
		? new Uint8Array(data)
		: data;
	const result = new LZMA().compress(input, mode);
	return new Uint8Array(result);
}

/**
 * Compresses data using LZMA algorithm
 *
 * @param data String to compress
 * @param mode Compression mode (1-9), defaults to 5
 * @returns Compressed data as byte array
 */
export function compressString(
	data: string,
	mode: CompressionMode = 5,
): Uint8Array {
	const compressedData = new LZMA().compressString(data, mode);
	return new Uint8Array(compressedData);
}

/**
 * Decompresses LZMA compressed data
 *
 * @param data Compressed data as Uint8Array or ArrayBuffer
 * @returns Decompressed data
 */
export function decompress(data: Uint8Array | ArrayBuffer): Uint8Array {
	const input = data instanceof ArrayBuffer
		? new Uint8Array(data)
		: data;
	const decompressedData = new LZMA().decompress(input);
	return new Uint8Array(decompressedData);
}

/**
 * Decompresses LZMA compressed data
 *
 * @param data Compressed data as Uint8Array or ArrayBuffer
 * @returns Decompressed data as string
 */
export function decompressString(data: Uint8Array | ArrayBuffer): string {
	return new LZMA().decompressString(data);
}
