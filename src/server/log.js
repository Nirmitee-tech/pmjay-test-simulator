'use strict';
// Message log: in memory (newest last, capped) and appended to data/log.jsonl.
const fs = require('fs');
const path = require('path');

class MessageLog {
  constructor(dataDir, toFile) {
    this.items = [];
    this.max = 2000;
    this.seq = 0;
    this.file = toFile ? path.join(dataDir, 'log.jsonl') : null;
    if (this.file) fs.mkdirSync(dataDir, { recursive: true });
  }
  add(entry) {
    const e = Object.assign({ id: ++this.seq, at: new Date().toISOString() }, entry);
    this.items.push(e);
    if (this.items.length > this.max) this.items.shift();
    this.write(e);
    return e;
  }
  update(id, patch) {
    const e = this.get(id);
    if (!e) return null;
    Object.assign(e, patch);
    this.write(Object.assign({ update: true }, e));
    return e;
  }
  get(id) { return this.items.find(x => x.id === Number(id)) || null; }
  write(e) {
    if (!this.file) return;
    try { fs.appendFileSync(this.file, JSON.stringify(e) + '\n'); } catch (_) { /* log file is a copy; memory is the source */ }
  }
  summary() {
    return this.items.slice().reverse().map(e => ({
      id: e.id, at: e.at, kind: e.kind, action: e.action, scenario: e.scenario || '',
      outcome: e.outcome || '', errorCode: e.errorCode || '', correlationId: e.correlationId || '',
      pending: !!e.pending,
    }));
  }
}

module.exports = { MessageLog };
