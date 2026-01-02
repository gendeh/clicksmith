import crypto from 'crypto';
import sharp from 'sharp';

export function computeSha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function computeDHash(buffer: Buffer): Promise<string> {
  const resized = await sharp(buffer)
    .grayscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer();

  const bits: number[] = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = resized[row * 9 + col];
      const right = resized[row * 9 + col + 1];
      bits.push(left < right ? 1 : 0);
    }
  }

  let hash = '';
  for (let i = 0; i < bits.length; i += 4) {
    const nibble = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3];
    hash += nibble.toString(16);
  }
  return hash;
}
