import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import type { ArtifactStorage } from '../platform/artifact-storage.port.js';
import {
  serializeCsv,
  type SerializeExportOptions,
} from './export-serializers.js';
import type {
  BackupReceipt,
  BackupSnapshot,
} from './workspace-backup-snapshot.js';

const SCHEMA_VERSION = 1;
const ARCHIVE_LIMIT = 50_000_000; // Private storage object limit (uncompressed ZIP).

export class BackupArtifactError extends Error {
  public readonly isDomainError = true;
}

interface Entry {
  readonly name: string;
  readonly bytes: Buffer;
  readonly count: number;
}

function attachmentKey(workspaceId: string, receipt: BackupReceipt): string {
  const expected = `workspaces/${workspaceId}/receipts/${receipt.id}/${receipt.file_name}`;
  if (
    !receipt.file_name ||
    /[/\\\p{Cc}]/u.test(receipt.file_name) ||
    ['.', '..'].includes(receipt.file_name) ||
    receipt.storage_path !== expected
  ) {
    throw new BackupArtifactError(
      'Invalid workspace receipt attachment reference.',
    );
  }
  return expected;
}

export async function renderWorkspaceBackup(
  workspaceId: string,
  snapshot: BackupSnapshot,
  storage: ArtifactStorage,
  options: Required<Pick<SerializeExportOptions, 'signal' | 'remainingMs'>>,
): Promise<Buffer> {
  const files: Entry[] = [];
  let archiveBytes = 22;
  function add(name: string, bytes: Buffer, count: number) {
    options.signal.throwIfAborted();
    archiveBytes += 76 + 2 * Buffer.byteLength(name) + bytes.length;
    if (archiveBytes > ARCHIVE_LIMIT || files.length >= 0xfffe) {
      throw new BackupArtifactError(
        'Workspace backup exceeds the supported archive size.',
      );
    }
    files.push({ name, bytes, count });
  }

  const receipts = [];
  for (const { storage_path, ...receipt } of snapshot.receipts) {
    const extension = /\.[a-z0-9]{1,12}$/i.exec(receipt.file_name)?.[0] ?? '';
    // Reconstruct rather than pass an unconstrained DB path into the privileged storage client.
    const key = attachmentKey(workspaceId, { storage_path, ...receipt });
    const attachment = `attachments/${receipt.id}${extension.toLowerCase()}`;
    add(attachment, await storage.download(key, options.signal), 1);
    receipts.push({ ...receipt, attachment });
  }

  const datasets = { ...snapshot.datasets, receipts };
  const metadata = {
    schemaVersion: SCHEMA_VERSION,
    workspaceId,
    snapshotAt: snapshot.snapshot_at.toISOString(),
  };
  const count = Object.values(datasets).reduce((n, rows) => n + rows.length, 0);
  add('workspace.json', json({ ...metadata, datasets }), count);
  for (const [name, rows] of Object.entries(datasets)) {
    const tabular = rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          value !== null && typeof value === 'object'
            ? JSON.stringify(value)
            : value,
        ]),
      ),
    );
    add(`csv/${name}.csv`, serializeCsv(tabular, options), rows.length);
  }
  const manifest = files.map(({ name, bytes, count }) => ({
    path: name,
    count,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }));
  add('manifest.json', json({ ...metadata, files: manifest }), files.length);
  return storedZip(files);
}

function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

// A ZIP32 STORE archive. Paths are generated from an allowlist/UUIDs, not upload names.
function storedZip(entries: readonly Entry[]): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  let directorySize = 0;
  for (const { name, bytes } of entries) {
    const path = Buffer.from(name);
    const checksum = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(33, 12); // DOS date: 1980-01-01
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(path.length, 26);
    parts.push(local, path, bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    local.copy(central, 6, 4, 30);
    central.writeUInt32LE(offset, 42);
    directory.push(central, path);
    offset += local.length + path.length + bytes.length;
    directorySize += central.length + path.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat(
    [...parts, ...directory, end],
    offset + directorySize + end.length,
  );
}
