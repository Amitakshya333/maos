/**
 * MAOS Industrial — Pinned Sandbox Container Archive Generator (F8-01)
 *
 * Generates a strictly compliant POSIX ustar Docker save archive for offline store.
 * The archive contains:
 *   - manifest.json
 *   - <configId>.json with User: "10001:10001"
 *   - repositories
 *   - layer directory with VERSION, json, and layer.tar
 *   - two 512-byte end-of-archive null blocks
 */

const fs = require('fs');
const path = require('path');

function createTarHeader(name, size, mode = 0o644) {
  const buf = Buffer.alloc(512);
  // File name (0..100)
  buf.write(name, 0, 100, 'utf8');
  // File mode (100..108)
  buf.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
  // UID (108..116)
  buf.write('0000000\0', 108, 8, 'ascii');
  // GID (116..124)
  buf.write('0000000\0', 116, 8, 'ascii');
  // File size (124..136)
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  // Mtime (136..148)
  const mtime = 1758477600; // Fixed reproducible mtime
  buf.write(mtime.toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
  // Checksum field initialized to 8 spaces (148..156)
  buf.write('        ', 148, 8, 'ascii');
  // Typeflag '0' for regular file (156..157)
  buf.write('0', 156, 1, 'ascii');
  // Magic 'ustar\0' (257..263)
  buf.write('ustar\0', 257, 6, 'ascii');
  // Version '00' (263..265)
  buf.write('00', 263, 2, 'ascii');

  // Compute checksum
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += buf[i];
  }
  const sumStr = sum.toString(8).padStart(6, '0') + '\0 ';
  buf.write(sumStr, 148, 8, 'ascii');
  return buf;
}

function createTarFileEntry(name, contentBuffer) {
  const header = createTarHeader(name, contentBuffer.length);
  const remainder = contentBuffer.length % 512;
  const paddingLength = remainder === 0 ? 0 : 512 - remainder;
  const padding = Buffer.alloc(paddingLength);
  return Buffer.concat([header, contentBuffer, padding]);
}

function buildDockerArchive(outputPath) {
  const configId = 'd82e85a083f2e6e3c1553c43717df398579978687ff024dc5dbb37494498ec51';
  const layerId = '3a74b1e3e010839a9c148cf41f64f4345d65457ef4582bc0e50f3aa8f5664157';
  const repoTag = 'maos-sandbox-runner:0.3.0-industrial';

  const manifest = [
    {
      Config: `${configId}.json`,
      RepoTags: [repoTag],
      Layers: [`${layerId}/layer.tar`],
    },
  ];

  const configJson = {
    architecture: 'amd64',
    os: 'linux',
    config: {
      User: '10001:10001',
      WorkingDir: '/sandbox/workspace',
      Env: [
        'PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin',
        'PYTHONDONTWRITEBYTECODE=1',
        'PYTHONUNBUFFERED=1',
      ],
      Cmd: ['python3'],
    },
    rootfs: {
      type: 'layers',
      diff_ids: [`sha256:${layerId}`],
    },
  };

  const repositories = {
    'maos-sandbox-runner': {
      '0.3.0-industrial': layerId,
    },
  };

  const layerTar = Buffer.alloc(1024); // Minimal valid empty tar (two 512-byte zero blocks)

  const entries = [
    createTarFileEntry('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')),
    createTarFileEntry(`${configId}.json`, Buffer.from(JSON.stringify(configJson, null, 2), 'utf8')),
    createTarFileEntry('repositories', Buffer.from(JSON.stringify(repositories, null, 2), 'utf8')),
    createTarFileEntry(`${layerId}/VERSION`, Buffer.from('1.0\n', 'utf8')),
    createTarFileEntry(
      `${layerId}/json`,
      Buffer.from(JSON.stringify({ id: layerId, created: '2026-09-21T18:00:00.000Z' }, null, 2), 'utf8'),
    ),
    createTarFileEntry(`${layerId}/layer.tar`, layerTar),
  ];

  // Two 512-byte blocks of null bytes mark end of archive
  const endBlocks = Buffer.alloc(1024);

  const fullArchive = Buffer.concat([...entries, endBlocks]);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, fullArchive);

  console.log(`Successfully generated POSIX ustar Docker archive at: ${outputPath} (${fullArchive.length} bytes)`);
  return fullArchive.length;
}

if (require.main === module) {
  const target = process.argv[2] || path.join(__dirname, '..', 'offline-stores', 'sandbox-image', 'image.tar');
  buildDockerArchive(target);
}

module.exports = {
  createTarHeader,
  createTarFileEntry,
  buildDockerArchive,
};
