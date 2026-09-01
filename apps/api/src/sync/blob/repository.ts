import type { BlobBody, BlobDownload, BlobStorage } from "./storage";

export type { BlobBody };

const R2_LIST_BATCH_SIZE = 1000;
const R2_DELETE_BATCH_SIZE = 1000;

export class BlobRepository implements BlobStorage {
	constructor(private readonly bucket: R2Bucket) {}

	async upload(key: string, body: BlobBody): Promise<{ size: number }> {
		const object = await this.bucket.put(key, body);
		if (!object) {
			throw new Error("blob upload did not return an R2 object");
		}

		return { size: object.size };
	}

	async download(key: string): Promise<BlobDownload | null> {
		const object = await this.bucket.get(key);
		return object ? { body: object.body, size: object.size } : null;
	}

	async delete(key: string): Promise<void> {
		await this.bucket.delete(key);
	}

	async deleteMany(keys: readonly string[]): Promise<void> {
		if (keys.length === 0) {
			return;
		}

		// R2 takes up to 1000 keys per call, so a GC batch is a single round trip.
		for (let i = 0; i < keys.length; i += R2_DELETE_BATCH_SIZE) {
			await this.bucket.delete([...keys.slice(i, i + R2_DELETE_BATCH_SIZE)]);
		}
	}

	async deleteByPrefix(prefix: string): Promise<void> {
		let cursor: string | undefined;

		do {
			const listed = await this.bucket.list({
				prefix,
				cursor,
				limit: R2_LIST_BATCH_SIZE,
			});
			const keys = listed.objects.map((object) => object.key);
			if (keys.length > 0) {
				await this.bucket.delete(keys);
			}
			cursor = listed.truncated ? listed.cursor : undefined;
		} while (cursor);
	}

	async exists(key: string): Promise<boolean> {
		const object = await this.bucket.head(key);
		return object !== null;
	}
}
