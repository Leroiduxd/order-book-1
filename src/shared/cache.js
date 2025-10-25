// Petit cache LRU/TTL pour éviter les doublons sans rater les events
export class EventCache {
  constructor({ max = 5000, ttlMs = 5 * 60 * 1000 } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map(); // key -> timestamp
  }

  _prune() {
    const now = Date.now();
    for (const [k, t] of this.map) {
      if (now - t > this.ttlMs) this.map.delete(k);
    }
    // soft-limit size
    if (this.map.size > this.max) {
      const drop = this.map.size - this.max;
      let i = 0;
      for (const k of this.map.keys()) {
        this.map.delete(k);
        if (++i >= drop) break;
      }
    }
  }

  // key typique: `${blockNumber}:${txHash}:${logIndex}`
  seen(key) {
    this._prune();
    if (this.map.has(key)) return true;
    this.map.set(key, Date.now());
    return false;
  }
}

// Helper pour fabriquer une clé unique fiable
export function eventKey(evt) {
  // evt.logIndex, evt.transactionHash, evt.blockNumber sont présents dans ethers v6
  const bn = evt.blockNumber ?? 'bn?';
  const li = evt.logIndex ?? 'li?';
  const tx = (evt.transactionHash || 'tx?').toLowerCase();
  return `${bn}:${tx}:${li}`;
}
