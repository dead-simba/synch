import { DomainError, domainApiError } from "../../../errors";
import { blobObjectKey } from "../../blob/object-key";
import type { MaintenanceScheduler } from "../maintenance-scheduler";
import type {
	BlobObjectRepository,
	BlobStateStore,
	HealthStateStore,
	HealthSummaryScheduler,
	SocketGateway,
	SyncTokenVerifier,
	VaultStateStore,
} from "../ports";

const GC_BATCH_SIZE = 64;

export class BlobSyncService {
	constructor(
		private readonly syncTokenService: SyncTokenVerifier,
		private readonly blobStore: BlobStateStore,
		private readonly vaultStateStore: Pick<VaultStateStore, "readVaultId">,
		private readonly healthStore: Pick<
			HealthStateStore,
			"recordGcCompleted" | "readStorageStatus"
		>,
		private readonly socketService: Pick<SocketGateway, "broadcastStorageStatus">,
		private readonly blobRepository: BlobObjectRepository,
		private readonly blobGracePeriodMs: number,
		private readonly maintenanceScheduler: MaintenanceScheduler,
		private readonly healthSummaryScheduler: HealthSummaryScheduler,
	) {}

	async stageBlob(
		request: Request,
		vaultId: string,
		blobId: string,
		sizeBytes: number,
	): Promise<void> {
		await this.syncTokenService.requireSyncToken(request, vaultId);

		const now = Date.now();
		try {
			await this.blobStore.stageBlob(
				blobId,
				sizeBytes,
				now,
				now + this.blobGracePeriodMs,
			);
			await this.maintenanceScheduler.defer(
				"blob_gc",
				now + this.blobGracePeriodMs,
				now,
			);
			this.broadcastStorageStatus();
		} catch (error) {
			if (error instanceof DomainError) {
				throw domainApiError(error);
			}
			throw error;
		}
	}

	async abortStagedBlob(
		request: Request,
		vaultId: string,
		blobId: string,
	): Promise<void> {
		await this.syncTokenService.requireSyncToken(request, vaultId);
		this.blobStore.abortStagedBlob(blobId, Date.now());
		await this.healthSummaryScheduler.scheduleSummaryFlush();
		this.broadcastStorageStatus();
	}

	async deleteBlob(request: Request, vaultId: string, blobId: string): Promise<void> {
		await this.syncTokenService.requireSyncToken(request, vaultId);
		const blob = this.blobStore.readBlob(blobId);
		if (blob && this.blobStore.isBlobPinned(blobId, false)) {
			return;
		}

		await this.blobRepository.delete(blobObjectKey(vaultId, blobId));
		if (blob) {
			this.blobStore.deleteBlobRecord(blobId);
			await this.healthSummaryScheduler.scheduleSummaryFlush();
			this.broadcastStorageStatus();
		}
	}

	async runGc(
		vaultId?: string,
		options: {
			now?: number;
			scheduleHealthFlush?: boolean;
			scheduleNextGc?: boolean;
		} = {},
	): Promise<number | null> {
		const effectiveVaultId = vaultId ?? this.vaultStateStore.readVaultId();
		if (!effectiveVaultId) {
			return null;
		}

		const now = options.now ?? Date.now();
		const due = this.blobStore.listBlobsReadyForDeletion(now, GC_BATCH_SIZE);
		if (due.length > 0) {
			// One round trip for the whole batch rather than one per blob. With a
			// backlog in the thousands the old loop was thousands of sequential
			// awaits inside a single Durable Object invocation, which is how the
			// coordinator started returning Cloudflare's 1102 (CPU or memory
			// exceeded) instead of a response - and the GC could never drain the
			// backlog it was being crushed by.
			await this.blobRepository.deleteMany(
				due.map((blob) => blobObjectKey(effectiveVaultId, blob.blob_id)),
			);
			for (const blob of due) {
				this.blobStore.deleteBlobIfCollectible(blob.blob_id, now);
			}
		}

		const nextGcAt = this.blobStore.nextBlobGcAt();
		if ((options.scheduleNextGc ?? true) && nextGcAt !== null) {
			await this.maintenanceScheduler.defer("blob_gc", nextGcAt, now);
		}
		this.healthStore.recordGcCompleted(now);
		if (options.scheduleHealthFlush ?? true) {
			await this.maintenanceScheduler.defer("health_summary_flush", now, now);
		}
		if (due.length > 0) {
			this.broadcastStorageStatus();
		}
		return nextGcAt;
	}

	async collectPurgedBlobs(
		vaultId: string,
		blobIds: readonly string[],
	): Promise<void> {
		const uniqueBlobIds = [...new Set(blobIds)];
		if (uniqueBlobIds.length === 0) {
			return;
		}

		const now = Date.now();
		let deletedCount = 0;
		for (const blobId of uniqueBlobIds) {
			this.blobStore.markBlobPendingDeleteIfUnpinned(blobId, now);
			const blob = this.blobStore.readBlob(blobId);
			if (
				!blob ||
				blob.state !== "pending_delete" ||
				(blob.delete_after !== null && blob.delete_after > now) ||
				this.blobStore.isBlobPinned(blobId, false, now)
			) {
				continue;
			}

			try {
				await this.blobRepository.delete(blobObjectKey(vaultId, blobId));
				this.blobStore.deleteBlobIfCollectible(blobId, now);
				deletedCount += 1;
			} catch (error) {
				console.error("[sync-coordinator] immediate purged blob deletion failed", {
					vaultId,
					blobId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		const nextGcAt = this.blobStore.nextBlobGcAt();
		if (nextGcAt !== null) {
			await this.maintenanceScheduler.defer("blob_gc", nextGcAt, now);
		}
		await this.healthSummaryScheduler.scheduleSummaryFlush(now);
		if (deletedCount > 0) {
			this.broadcastStorageStatus();
		}
	}

	private broadcastStorageStatus(): void {
		const storageStatus = this.healthStore.readStorageStatus();
		this.socketService.broadcastStorageStatus({
			type: "storage_status_updated",
			storageStatus,
		});
	}
}
