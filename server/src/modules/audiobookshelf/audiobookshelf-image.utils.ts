import sharp from 'sharp';

/** Whether the given bytes decode as a real raster image. Guards against writing a corrupt cover file over an existing one. */
export async function isDecodableImage(bytes: Buffer): Promise<boolean> {
  if (bytes.length === 0) return false;
  try {
    const metadata = await sharp(bytes).metadata();
    return Boolean(metadata.width && metadata.height);
  } catch {
    return false;
  }
}
