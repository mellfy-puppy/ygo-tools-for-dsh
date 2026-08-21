import type { InputBuffer } from "./streams.js";
import {
	CRC32_TABLE,
	DICTIONARY_SIZE_THRESHOLD,
} from "./utils.js";

/**
 * BinTreeMatchFinder — Binary tree match finder for LZMA encoding.
 *
 * Combines input window management, hash-based match finding, and
 * binary tree search into a single cohesive class.
 */
export class BinTreeMatchFinder {
	// Input window fields
	_posLimit: number = 0;
	_bufferBase: Uint8Array = new Uint8Array(0);
	_pos: number = 0;
	_streamPos: number = 0;
	_streamEndWasReached: number = 0;
	_bufferOffset: number = 0;
	_blockSize: number = 0;
	_keepSizeBefore: number = 0;
	_keepSizeAfter: number = 0;
	_pointerToLastSafePosition: number = 0;
	_stream: InputBuffer | null = null;

	// Hash and tree fields
	HASH_ARRAY: boolean = true;
	kNumHashDirectBytes: number = 0;
	kMinMatchCheck: number = 4;
	kFixHashSize: number = 66560;
	_hashMask: number = 0;
	_hashSizeSum: number = 0;
	_hash: Int32Array = new Int32Array(0);
	_cyclicBufferSize: number = 0;
	_cyclicBufferPos: number = 0;
	_son: Int32Array = new Int32Array(0);
	_matchMaxLen: number = 0;
	_cutValue: number = 0xff;

	// --- LzInWindow methods ---

	getIndexByte(index: number): number {
		return this._bufferBase[this._bufferOffset + this._pos + index];
	}

	getMatchLen(index: number, distance: number, limit: number): number {
		if (this._streamEndWasReached) {
			if (this._pos + index + limit > this._streamPos) {
				limit = this._streamPos - (this._pos + index);
			}
		}

		++distance;
		let i;
		const pby = this._bufferOffset + this._pos + index;

		for (
			i = 0;
			i < limit
			&& this._bufferBase[pby + i]
				== this._bufferBase[pby + i - distance];
			++i
		);

		return i;
	}

	getNumAvailableBytes(): number {
		return this._streamPos - this._pos;
	}

	moveBlock(): void {
		let offset = this._bufferOffset + this._pos - this._keepSizeBefore;

		if (offset > 0) {
			--offset;
		}

		const numBytes = this._bufferOffset + this._streamPos - offset;
		this._bufferBase.copyWithin(0, offset, offset + numBytes);

		this._bufferOffset -= offset;
	}

	movePosInWindow(): void {
		this._pos += 1;

		if (this._pos > this._posLimit) {
			const pointerToPosition = this._bufferOffset + this._pos;

			if (pointerToPosition > this._pointerToLastSafePosition) {
				this.moveBlock();
			}

			this.readBlock();
		}
	}

	readBlock(): void {
		if (this._streamEndWasReached) {
			return;
		}

		while (true) {
			const size = -this._bufferOffset + this._blockSize - this._streamPos;
			if (!size) {
				return;
			}

			const bytesRead = this.readFromStream(
				this._bufferOffset + this._streamPos,
				size,
			);

			if (bytesRead == -1) {
				this._posLimit = this._streamPos;
				const pointerToPosition = this._bufferOffset + this._posLimit;

				if (pointerToPosition > this._pointerToLastSafePosition) {
					this._posLimit = this._pointerToLastSafePosition - this._bufferOffset;
				}

				this._streamEndWasReached = 1;
				return;
			}

			this._streamPos += bytesRead;
			if (this._streamPos >= this._pos + this._keepSizeAfter) {
				this._posLimit = this._streamPos - this._keepSizeAfter;
			}
		}
	}

	reduceOffsets(subValue: number): void {
		this._bufferOffset += subValue;
		this._posLimit -= subValue;
		this._pos -= subValue;
		this._streamPos -= subValue;
	}

	private readFromStream(off: number, len: number): number {
		const stream = this._stream!;
		const buffer = this._bufferBase;

		return stream.readBytes(buffer, off, len);
	}

	// --- Match finder configuration methods ---

	createBuffers(
		keepSizeBefore: number,
		keepSizeAfter: number,
		keepSizeReserv: number,
	): void {
		this._keepSizeBefore = keepSizeBefore;
		this._keepSizeAfter = keepSizeAfter;
		const blockSize = keepSizeBefore + keepSizeAfter + keepSizeReserv;

		if (this._blockSize != blockSize) {
			this._bufferBase = new Uint8Array(blockSize);
			this._blockSize = blockSize;
		}

		this._pointerToLastSafePosition = this._blockSize - keepSizeAfter;
	}

	create(
		dictionarySize: number,
		numFastBytes: number,
		keepAddBufferBefore: number,
		keepAddBufferAfter: number,
	): void {
		if (dictionarySize < DICTIONARY_SIZE_THRESHOLD) {
			this._cutValue = 0x10 + (numFastBytes >> 1);

			const windowReservSize = ~~((dictionarySize + keepAddBufferBefore + numFastBytes + keepAddBufferAfter) / 2) + 0x100;

			this.createBuffers(
				dictionarySize + keepAddBufferBefore,
				numFastBytes + keepAddBufferAfter,
				windowReservSize,
			);

			this._matchMaxLen = numFastBytes;

			// Ensure cyclic buffer
			const cyclicBufferSize = dictionarySize + 1;
			if (this._cyclicBufferSize !== cyclicBufferSize) {
				this._cyclicBufferSize = cyclicBufferSize;
				this._son = new Int32Array(cyclicBufferSize * 2);
			}

			// Compute hash size
			let hs = 0x10000;

			if (this.HASH_ARRAY) {
				hs = dictionarySize - 1;
				hs |= hs >> 1;
				hs |= hs >> 2;
				hs |= hs >> 4;
				hs |= hs >> 0x08;
				hs >>= 1;
				hs |= 0xFFFF;

				if (hs > 0x1000000) {
					hs >>= 1;
				}

				this._hashMask = hs;
				hs += 1;

				const finalHashSizeSum = hs + this.kFixHashSize;

				if (finalHashSizeSum !== this._hashSizeSum) {
					this._hashSizeSum = finalHashSizeSum;
					this._hash = new Int32Array(finalHashSizeSum);
				}
			} else {
				if (hs !== this._hashSizeSum) {
					this._hashSizeSum = hs;
					this._hash = new Int32Array(hs);
				}
			}
		}
	}

	// --- Match finding methods ---

	getMatches(distances: number[]): number {
		let count,
			cur,
			curMatch,
			curMatch2,
			curMatch3,
			cyclicPos,
			delta,
			hash2Value,
			hash3Value,
			hashValue,
			len,
			len0,
			len1,
			lenLimit,
			matchMinPos,
			maxLen,
			offset,
			pby1,
			ptr0,
			ptr1,
			temp;

		if (this._pos + this._matchMaxLen <= this._streamPos) {
			lenLimit = this._matchMaxLen;
		} else {
			lenLimit = this._streamPos - this._pos;
			if (lenLimit < this.kMinMatchCheck) {
				this.movePos();
				return 0;
			}
		}

		offset = 0;
		matchMinPos = this._pos > this._cyclicBufferSize
			? this._pos - this._cyclicBufferSize
			: 0;

		cur = this._bufferOffset + this._pos;
		maxLen = 1;
		hash2Value = 0;
		hash3Value = 0;

		if (this.HASH_ARRAY) {
			temp = CRC32_TABLE[this._bufferBase[cur]] ^ this._bufferBase[cur + 1];
			hash2Value = temp & 0x3FF;
			temp ^= this._bufferBase[cur + 2] << 0x08;
			hash3Value = temp & 0xFFFF;
			hashValue = (temp ^ (CRC32_TABLE[this._bufferBase[cur + 3]] << 5)) & this._hashMask;
		} else {
			hashValue = this._bufferBase[cur] ^ (this._bufferBase[cur + 1] << 0x08);
		}

		curMatch = this._hash[this.kFixHashSize + hashValue] || 0;
		if (this.HASH_ARRAY) {
			curMatch2 = this._hash[hash2Value] || 0;
			curMatch3 = this._hash[0x400 + hash3Value] || 0;
			this._hash[hash2Value] = this._pos;
			this._hash[0x400 + hash3Value] = this._pos;

			if (curMatch2 > matchMinPos) {
				if (this._bufferBase[this._bufferOffset + curMatch2] == this._bufferBase[cur]) {
					distances[offset++] = maxLen = 2;
					distances[offset++] = this._pos - curMatch2 - 1;
				}
			}

			if (curMatch3 > matchMinPos) {
				if (this._bufferBase[this._bufferOffset + curMatch3] == this._bufferBase[cur]) {
					if (curMatch3 == curMatch2) {
						offset -= 2;
					}
					distances[offset++] = maxLen = 3;
					distances[offset++] = this._pos - curMatch3 - 1;
					curMatch2 = curMatch3;
				}
			}

			if (offset != 0 && curMatch2 == curMatch) {
				offset -= 2;
				maxLen = 1;
			}
		}

		this._hash[this.kFixHashSize + hashValue] = this._pos;
		ptr0 = (this._cyclicBufferPos << 1) + 1;
		ptr1 = this._cyclicBufferPos << 1;
		len0 = len1 = this.kNumHashDirectBytes;

		if (this.kNumHashDirectBytes != 0) {
			if (curMatch > matchMinPos) {
				if (
					this._bufferBase[
						this._bufferOffset + curMatch + this.kNumHashDirectBytes
					] != this._bufferBase[cur + this.kNumHashDirectBytes]
				) {
					distances[offset++] = maxLen = this.kNumHashDirectBytes;
					distances[offset++] = this._pos - curMatch - 1;
				}
			}
		}
		count = this._cutValue;

		while (1) {
			if (curMatch <= matchMinPos || count == 0) {
				count -= 1;
				this._son[ptr0] = this._son[ptr1] = 0;
				break;
			}
			delta = this._pos - curMatch;

			cyclicPos = (delta <= this._cyclicBufferPos
				? this._cyclicBufferPos - delta
				: this._cyclicBufferPos - delta + this._cyclicBufferSize) << 1;

			pby1 = this._bufferOffset + curMatch;
			len = len0 < len1 ? len0 : len1;

			if (
				this._bufferBase[pby1 + len] == this._bufferBase[cur + len]
			) {
				while ((len += 1) != lenLimit) {
					if (
						this._bufferBase[pby1 + len] != this._bufferBase[cur + len]
					) {
						break;
					}
				}

				if (maxLen < len) {
					distances[offset++] = maxLen = len;
					distances[offset++] = delta - 1;
					if (len == lenLimit) {
						this._son[ptr1] = this._son[cyclicPos];
						this._son[ptr0] = this._son[cyclicPos + 1];
						break;
					}
				}
			}

			if (
				this._bufferBase[pby1 + len] < this._bufferBase[cur + len]
			) {
				this._son[ptr1] = curMatch;
				ptr1 = cyclicPos + 1;
				curMatch = this._son[ptr1];
				len1 = len;
			} else {
				this._son[ptr0] = curMatch;
				ptr0 = cyclicPos;
				curMatch = this._son[ptr0];
				len0 = len;
			}
		}

		this.movePos();
		return offset;
	}

	skip(num: number): void {
		let count,
			cur,
			curMatch,
			cyclicPos,
			delta,
			hash2Value,
			hash3Value,
			hashValue,
			len,
			len0,
			len1,
			lenLimit,
			matchMinPos,
			pby1,
			ptr0,
			ptr1,
			temp;

		do {
			if (this._pos + this._matchMaxLen <= this._streamPos) {
				lenLimit = this._matchMaxLen;
			} else {
				lenLimit = this._streamPos - this._pos;
				if (lenLimit < this.kMinMatchCheck) {
					this.movePos();
					continue;
				}
			}

			matchMinPos = this._pos > this._cyclicBufferSize
				? this._pos - this._cyclicBufferSize
				: 0;

			cur = this._bufferOffset + this._pos;

			if (this.HASH_ARRAY) {
				temp = CRC32_TABLE[this._bufferBase[cur]] ^ this._bufferBase[cur + 1];
				hash2Value = temp & 0x3FF;
				this._hash[hash2Value] = this._pos;
				temp ^= this._bufferBase[cur + 2] << 0x08;
				hash3Value = temp & 0xFFFF;
				this._hash[0x400 + hash3Value] = this._pos;
				hashValue = (temp ^ (CRC32_TABLE[this._bufferBase[cur + 3]] << 5)) & this._hashMask;
			} else {
				hashValue = this._bufferBase[cur] ^ (this._bufferBase[cur + 1] << 0x08);
			}

			curMatch = this._hash[this.kFixHashSize + hashValue];
			this._hash[this.kFixHashSize + hashValue] = this._pos;
			ptr0 = (this._cyclicBufferPos << 1) + 1;
			ptr1 = this._cyclicBufferPos << 1;
			len0 = len1 = this.kNumHashDirectBytes;
			count = this._cutValue;

			while (1) {
				if (curMatch <= matchMinPos || count == 0) {
					count -= 1;
					this._son[ptr0] = this._son[ptr1] = 0;
					break;
				}
				delta = this._pos - curMatch;

				cyclicPos = (delta <= this._cyclicBufferPos
					? this._cyclicBufferPos - delta
					: this._cyclicBufferPos - delta + this._cyclicBufferSize) << 1;

				pby1 = this._bufferOffset + curMatch;

				len = len0 < len1 ? len0 : len1;

				if (this._bufferBase[pby1 + len] == this._bufferBase[cur + len]) {
					while ((len += 1) != lenLimit) {
						if (
							this._bufferBase[pby1 + len] != this._bufferBase[cur + len]
						) {
							break;
						}
					}

					if (len == lenLimit) {
						this._son[ptr1] = this._son[cyclicPos];
						this._son[ptr0] = this._son[cyclicPos + 1];
						break;
					}
				}

				if (this._bufferBase[pby1 + len] < this._bufferBase[cur + len]) {
					this._son[ptr1] = curMatch;
					ptr1 = cyclicPos + 1;
					curMatch = this._son[ptr1];
					len1 = len;
				} else {
					this._son[ptr0] = curMatch;
					ptr0 = cyclicPos;
					curMatch = this._son[ptr0];
					len0 = len;
				}
			}
			this.movePos();
		} while ((num -= 1) != 0);
	}

	movePos(): void {
		if ((this._cyclicBufferPos += 1) >= this._cyclicBufferSize) {
			this._cyclicBufferPos = 0;
		}

		this.movePosInWindow();

		if (this._pos == DICTIONARY_SIZE_THRESHOLD) {
			const subValue = this._pos - this._cyclicBufferSize;

			this.normalizeLinks(this._son, this._cyclicBufferSize * 2, subValue);
			this.normalizeLinks(this._hash, this._hashSizeSum, subValue);

			this.reduceOffsets(subValue);
		}
	}

	init(): void {
		this._bufferOffset = 0;
		this._pos = 0;
		this._streamPos = 0;
		this._streamEndWasReached = 0;
		this.readBlock();

		this._cyclicBufferPos = 0;
		this.reduceOffsets(-1);
	}

	/**
	 * This is only called after reading one whole gigabyte.
	 */
	normalizeLinks(items: Int32Array, numItems: number, subValue: number): void {
		for (let i = 0; i < numItems; ++i) {
			let value = items[i];
			if (value <= subValue) {
				value = 0;
			} else {
				value -= subValue;
			}
			items[i] = value;
		}
	}

	setType(numHashBytes: number): void {
		this.HASH_ARRAY = numHashBytes > 2;

		if (this.HASH_ARRAY) {
			this.kNumHashDirectBytes = 0;
			this.kMinMatchCheck = 4;
			this.kFixHashSize = 66560;
		} else {
			this.kNumHashDirectBytes = 2;
			this.kMinMatchCheck = 3;
			this.kFixHashSize = 0;
		}
	}
}
