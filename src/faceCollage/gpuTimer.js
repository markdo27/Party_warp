/**
 * GPU time per frame via EXT_disjoint_timer_query_webgl2 (architecture-r5 §6.2, debug only).
 * Results arrive a few frames late, so queries sit in a small pool and are polled without
 * blocking. A disjoint event (GPU clock reset, power state) drops the pending results.
 * When the extension is missing, `available` is false and the HUD shows "n/a".
 */
const MAX_PENDING = 4;
const AVG_FRAMES = 30;

export class GpuTimer {
  /** @param {WebGL2RenderingContext} gl */
  constructor(gl) {
    this.gl = gl;
    this.reattach();
  }

  /** Context created or restored: fetch the extension again, old queries are gone. */
  reattach() {
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.available = Boolean(this.ext);
    this.samples = [];
    this.ms = null;
    this.reset();
  }

  /** Context lost: query objects are invalid, forget them without deleting. */
  reset() {
    this.free = [];
    this.pending = [];
    this.active = null;
  }

  begin() {
    if (!this.available || this.active) return;
    this.poll();
    if (this.pending.length >= MAX_PENDING) return; // GPU far behind: skip a sample, never stall
    const q = this.free.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end() {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending = [...this.pending, this.active];
    this.active = null;
  }

  poll() {
    const { gl, ext } = this;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    let done = 0;
    const fresh = [];
    for (const q of this.pending) {
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!disjoint) fresh.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      done += 1;
    }
    if (disjoint) {
      // Every result in flight is suspect; recycle all of them.
      this.free = [...this.free, ...this.pending];
      this.pending = [];
      return;
    }
    if (!done) return;
    this.free = [...this.free, ...this.pending.slice(0, done)];
    this.pending = this.pending.slice(done);
    this.samples = [...this.samples, ...fresh].slice(-AVG_FRAMES);
    this.ms = Math.round((this.samples.reduce((a, b) => a + b, 0) / this.samples.length) * 100) / 100;
  }

  dispose() {
    if (this.active) this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    [...this.free, ...this.pending, this.active].filter(Boolean).forEach((q) => this.gl.deleteQuery(q));
    this.reset();
  }
}
