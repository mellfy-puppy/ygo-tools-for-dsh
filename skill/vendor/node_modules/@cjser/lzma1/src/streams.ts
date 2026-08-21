/**
 * Read-only input buffer wrapping a Uint8Array.
 */
export class InputBuffer {
	buf: Uint8Array;
	pos: number = 0;
	count: number;

	constructor(data: Uint8Array) {
		this.buf = data;
		this.count = data.length;
	}

	readByte(): number {
		if (this.pos >= this.count) return -1;
		return this.buf[this.pos++] & 0xFF;
	}

	readBytes(dest: Uint8Array, off: number, len: number): number {
		if (this.pos >= this.count) return -1;
		len = Math.min(len, this.count - this.pos);
		dest.set(this.buf.subarray(this.pos, this.pos + len), off);
		this.pos += len;
		return len;
	}

	get remaining(): number {
		return this.count - this.pos;
	}
}

/**
 * Growable output buffer backed by a Uint8Array.
 */
export class OutputBuffer {
	buf: Uint8Array;
	count: number = 0;

	constructor(capacity: number = 32) {
		this.buf = new Uint8Array(capacity);
	}

	private grow(requiredSize: number): void {
		const newSize = Math.max(this.buf.length * 2, requiredSize);
		const newBuf = new Uint8Array(newSize);
		newBuf.set(this.buf.subarray(0, this.count));
		this.buf = newBuf;
	}

	writeByte(b: number): void {
		if (this.count >= this.buf.length) {
			this.grow(this.count + 1);
		}
		this.buf[this.count++] = b;
	}

	writeBytes(src: Uint8Array, off: number, len: number): void {
		const requiredSize = this.count + len;
		if (requiredSize > this.buf.length) {
			this.grow(requiredSize);
		}
		this.buf.set(src.subarray(off, off + len), this.count);
		this.count += len;
	}

	write(buf: Uint8Array): void {
		this.writeBytes(buf, 0, buf.length);
	}

	toArray(): Uint8Array {
		return this.buf.slice(0, this.count);
	}
}
