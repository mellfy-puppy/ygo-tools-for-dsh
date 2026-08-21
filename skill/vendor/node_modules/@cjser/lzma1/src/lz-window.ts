import type { OutputBuffer } from "./streams.js";

export class LzOutWindow {
	buffer: Uint8Array | null = null;
	pos: number = 0;
	streamPos: number = 0;
	stream: OutputBuffer | null = null;
	windowSize: number = 0;

	// Private Go-style properties
	private w: OutputBuffer | null = null;
	private buf: Uint8Array;

	constructor(writer: OutputBuffer | null = null, windowSize: number = 4096) {
		this.w = writer;
		this.stream = writer;
		this.windowSize = windowSize;
		this.buf = new Uint8Array(windowSize);
		this.buffer = this.buf;
		this.pos = 0;
		this.streamPos = 0;
	}

	/**
	 * Copy a block of data from a previous position (LZ77-style)
	 */
	copyBlock(distance: number, length: number): void {
		if (!this.buffer) return;

		for (let i = 0; i < length; i++) {
			// Get byte from previous position
			let sourcePos = this.pos - distance - 1;
			if (sourcePos < 0) {
				sourcePos += this.windowSize;
			}

			const byte = this.buffer[sourcePos];
			this.putByte(byte);
		}
	}

	/**
	 * Put a single byte into the window
	 */
	putByte(byte: number): void {
		if (!this.buffer) return;

		this.buffer[this.pos] = byte;
		this.pos++;
		this.streamPos++;

		if (this.pos >= this.windowSize) {
			this.flush();
		}
	}

	/**
	 * Get a byte from a relative position
	 */
	getByte(relativePos: number): number {
		if (!this.buffer) return 0;

		let pos = this.pos + relativePos;
		if (pos < 0) {
			pos += this.windowSize;
		} else if (pos >= this.windowSize) {
			pos -= this.windowSize;
		}
		return this.buffer[pos];
	}

	/**
	 * Flush buffered data to output writer
	 */
	flush(): void {
		if (this.w && this.buffer && this.pos > 0) {
			this.w.writeBytes(this.buffer, 0, this.pos);
			this.pos = 0;
		}
	}

	/**
	 * Check if the window is empty
	 */
	isEmpty(): boolean {
		return this.streamPos === 0;
	}

	/**
	 * Reset the window
	 */
	reset(): void {
		this.pos = 0;
		this.streamPos = 0;
		if (this.buffer) {
			this.buffer.fill(0);
		}
	}
}
