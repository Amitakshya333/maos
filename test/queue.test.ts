import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createTask, getPendingTasks } from '../src/core/queue';

test('createTask does not overwrite tasks created in the same millisecond', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-queue-'));
  const originalNow = Date.now;
  Date.now = () => 1_700_000_000_000;

  try {
    const first = createTask({ agent: 'AUTO', description: 'first task', cwd });
    const second = createTask({ agent: 'AUTO', description: 'second task', cwd });

    assert.notEqual(first.id, second.id);
    assert.notEqual(first.filePath, second.filePath);
    assert.equal(getPendingTasks(cwd).length, 2);
    assert.match(fs.readFileSync(first.filePath, 'utf-8'), /first task/);
    assert.match(fs.readFileSync(second.filePath, 'utf-8'), /second task/);
  } finally {
    Date.now = originalNow;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

