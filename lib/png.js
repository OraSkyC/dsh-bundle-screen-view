// Zero-dependency PNG encoder for top-down BGRA rasters (the layout GDI
// GetDIBits produces with a negative-height BITMAPINFOHEADER).
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const out = Buffer.alloc(8 + data.length + 4);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 'ascii');
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

/**
 * Encode one top-down BGRA raster as an 8-bit RGBA PNG.
 * @param bgra - raster bytes, row-major, blue first.
 * @param w - raster width in pixels.
 * @param h - raster height in pixels.
 * @returns the encoded PNG bytes.
 */
export function encodePng(bgra, w, h) {
	const raw = Buffer.alloc(h * (1 + w * 4));
	for (let y = 0; y < h; y++) {
		const dst = y * (1 + w * 4);
		raw[dst] = 0; // filter type: none
		const src = y * w * 4;
		for (let x = 0; x < w; x++) {
			const s = src + x * 4;
			const d = dst + 1 + x * 4;
			raw[d] = bgra[s + 2];
			raw[d + 1] = bgra[s + 1];
			raw[d + 2] = bgra[s];
			raw[d + 3] = bgra[s + 3];
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type: RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
		chunk('IEND', Buffer.alloc(0)),
	]);
}
