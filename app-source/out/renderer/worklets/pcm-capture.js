// AudioWorklet: collects microphone samples (mono, at the AudioContext's
// 16 kHz rate) in 4096-frame chunks and posts them to the page, together with
// the context frame of the very first sample, so the page can tell exactly
// which wall-clock moment the recording starts at (voice <-> step sync).
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.started = false;
    // 'flush' at stop: hand over the last partial chunk, then confirm.
    this.port.onmessage = (e) => {
      if (e.data !== 'flush') return;
      if (this.n) this.port.postMessage({ type: 'data', samples: this.buf.slice(0, this.n) });
      this.n = 0;
      this.port.postMessage({ type: 'flushed' });
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (!this.started) {
      this.started = true;
      this.port.postMessage({ type: 'start', frame: currentFrame });
    }
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) {
        this.port.postMessage({ type: 'data', samples: this.buf }, [this.buf.buffer]);
        this.buf = new Float32Array(4096);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
