import { useCallback, useEffect, useRef, useState } from 'react';
import { cameraSupport, isFrontFacing, listCameras, mapCameraError, openCamera, stopStream } from './camera.js';
import { CollageEngine } from './engine.js';
import { COUNT_LIMITS, PRESETS, clampCount } from './layout.js';
import { randomSeed, seedToText, textToSeed } from './prng.js';
import { extensionFor, startRecording } from './recorder.js';
import { createTracker } from './tracker.js';
import { ERROR_COPY } from './copy.js';
import './faceCollage.css';

const query = new URLSearchParams(window.location.search);
const DEBUG = query.get('debug') === '1';
const INITIAL_SEED = textToSeed(query.get('seed') ?? '') ?? randomSeed();
const COUNT_KEYS = [
  ['eye', 'Eyes'],
  ['nose', 'Noses'],
  ['mouth', 'Mouths'],
  ['cheek', 'Cheeks'],
];
const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function FaceCollageApp() {
  const canvasRef = useRef(null);
  const videoRef = useRef(null);
  const engineRef = useRef(null);
  const trackerRef = useRef(null);
  const streamRef = useRef(null);
  const recRef = useRef(null);
  const [screen, setScreen] = useState('intro'); // intro | loading | active | stopped | error
  const [errorKind, setErrorKind] = useState(null);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState('searching');
  const [preset, setPreset] = useState('default');
  const [counts, setCounts] = useState(PRESETS.default.counts);
  const [glitch, setGlitch] = useState(PRESETS.default.glitch);
  const [seed, setSeed] = useState(INITIAL_SEED);
  const [seedText, setSeedText] = useState(seedToText(INITIAL_SEED));
  const [cameras, setCameras] = useState([]);
  const [deviceId, setDeviceId] = useState(null);
  const [mode, setMode] = useState('camera'); // camera | photo
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState('');
  const [hud, setHud] = useState(null);

  const fail = useCallback((kind) => {
    setErrorKind(kind);
    setScreen('error');
  }, []);

  const releaseCamera = useCallback(() => {
    recRef.current?.stop();
    engineRef.current?.stop();
    stopStream(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const ensureEngine = useCallback(async () => {
    if (!trackerRef.current) {
      setProgress(0);
      trackerRef.current = await createTracker({ onProgress: setProgress });
    }
    if (!engineRef.current) {
      engineRef.current = new CollageEngine({
        canvas: canvasRef.current,
        tracker: trackerRef.current,
        reducedMotion: prefersReducedMotion(),
        onPhase: setPhase,
      });
    }
    return engineRef.current;
  }, []);

  const startCamera = useCallback(
    async (wantedId = deviceId) => {
      const unsupported = cameraSupport();
      if (unsupported) return fail(unsupported);
      releaseCamera();
      setScreen('loading');
      setMode('camera');
      let stream;
      try {
        stream = await openCamera({ deviceId: wantedId ?? undefined });
      } catch (err) {
        return fail(mapCameraError(err));
      }
      streamRef.current = stream;
      let engine;
      try {
        engine = await ensureEngine();
      } catch (err) {
        console.error('[face-collage] model failed', err);
        releaseCamera();
        return fail('model-error');
      }
      if (streamRef.current !== stream) return undefined; // stopped while loading
      const video = videoRef.current;
      video.srcObject = stream;
      try {
        await video.play();
      } catch (err) {
        releaseCamera();
        return fail(mapCameraError(err));
      }
      setCameras(await listCameras());
      engine.start(video, { mirror: isFrontFacing(stream) });
      setScreen('active');
      return undefined;
    },
    [deviceId, ensureEngine, fail, releaseCamera],
  );

  const startPhoto = useCallback(
    async (file) => {
      if (!file) return;
      releaseCamera();
      setScreen('loading');
      setMode('photo');
      const img = new Image();
      const url = URL.createObjectURL(file);
      try {
        img.src = url;
        await img.decode();
        const engine = await ensureEngine();
        engine.start(img, { mirror: false });
        setScreen('active');
      } catch (err) {
        console.error('[face-collage] photo failed', err);
        fail(trackerRef.current ? 'photo-error' : 'model-error');
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    [ensureEngine, fail, releaseCamera],
  );

  const stopAll = useCallback(() => {
    releaseCamera();
    setRecording(false);
    setScreen('stopped');
  }, [releaseCamera]);

  // Release the camera when the tab is hidden or the demo unmounts (foundation D4).
  useEffect(() => {
    const onHide = () => document.visibilityState === 'hidden' && streamRef.current && stopAll();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', releaseCamera);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', releaseCamera);
      releaseCamera();
      trackerRef.current?.close();
      trackerRef.current = null;
      engineRef.current = null;
    };
  }, [releaseCamera, stopAll]);

  useEffect(() => {
    engineRef.current?.setParams({ seed, counts, glitch });
  }, [seed, counts, glitch, screen]);

  useEffect(() => {
    window.__faceCollage = {
      ui: () => ({ screen, errorKind, mode, recording }),
      snapshot: () => engineRef.current?.snapshot() ?? null,
      trackStates: () => streamRef.current?.getTracks().map((t) => t.readyState) ?? [],
    };
  }, [screen, errorKind, mode, recording]);

  useEffect(() => {
    if (!DEBUG || screen !== 'active') return undefined;
    const id = setInterval(() => setHud(engineRef.current?.snapshot() ?? null), 250);
    return () => clearInterval(id);
  }, [screen]);

  const applyPreset = (key) => {
    setPreset(key);
    setCounts(PRESETS[key].counts);
    setGlitch(PRESETS[key].glitch);
  };
  const setCount = (kind, value) => {
    setPreset('custom');
    setCounts((c) => ({ ...c, [kind]: clampCount(kind, value) }));
  };
  const reroll = () => {
    const next = randomSeed();
    setSeed(next);
    setSeedText(seedToText(next));
  };
  const commitSeed = () => {
    const parsed = textToSeed(seedText);
    if (parsed === null) {
      setSeedText(seedToText(seed));
      setNotice('Seed must be 1 to 6 letters or digits');
      return;
    }
    setSeed(parsed);
    setNotice('');
  };
  const switchCamera = () => {
    const ids = cameras.map((c) => c.deviceId);
    const current = streamRef.current?.getVideoTracks()[0]?.getSettings().deviceId;
    const next = ids[(ids.indexOf(current) + 1) % ids.length];
    setDeviceId(next);
    startCamera(next);
  };
  const savePng = async () => {
    try {
      download(await engineRef.current.toPng(), `face-collage-${seedToText(seed)}.png`);
    } catch (err) {
      setNotice(err.message);
    }
  };
  const toggleRecord = async () => {
    if (recRef.current) {
      recRef.current.stop();
      return;
    }
    try {
      const rec = startRecording(canvasRef.current);
      recRef.current = rec;
      setRecording(true);
      const blob = await rec.done;
      download(blob, `face-collage-${seedToText(seed)}.${extensionFor(rec.type)}`);
    } catch (err) {
      setNotice(err?.message ?? 'Recording failed');
    } finally {
      recRef.current = null;
      setRecording(false);
    }
  };

  const active = screen === 'active';
  const copy = ERROR_COPY[errorKind] ?? ERROR_COPY['camera-error'];

  return (
    <div className="fc">
      <header className="fc-head">
        <a href="./" className="fc-back">Party Warp</a>
        <h1>Face Collage</h1>
        <span className="fc-tag">prototype</span>
      </header>
      <main className="fc-main">
        <section className="fc-stage" aria-label="Preview">
          <canvas ref={canvasRef} className={active ? 'fc-canvas' : 'fc-canvas fc-hidden'} data-testid="fc-canvas" />
          <video ref={videoRef} className="fc-video" muted playsInline aria-hidden="true" />
          {active && mode === 'camera' && phase !== 'tracking' && phase !== 'holding' && (
            <p className="fc-hint" role="status">{phase === 'lost' ? 'Face lost. Look at the camera.' : 'Looking for a face…'}</p>
          )}
          {screen === 'intro' && (
            <div className="fc-panel">
              <h2>Turn your face into a collage</h2>
              <p>Wipes your face and keeps only the eyes and mouth, then pastes extra copies around it.</p>
              <button type="button" className="fc-btn fc-primary" onClick={() => startCamera()}>Start camera</button>
              <PhotoButton onFile={startPhoto} />
              <p className="fc-small">Everything runs on this device. No image is uploaded.</p>
            </div>
          )}
          {screen === 'loading' && (
            <div className="fc-panel" role="status">
              <h2>Loading face tracker</h2>
              <progress max="1" value={progress} aria-label="Model download" />
              <p className="fc-small">{Math.round(progress * 100)}% · about 18 MB the first time, cached after</p>
            </div>
          )}
          {screen === 'stopped' && (
            <div className="fc-panel">
              <h2>Camera off</h2>
              <button type="button" className="fc-btn fc-primary" onClick={() => startCamera()}>Start again</button>
              <PhotoButton onFile={startPhoto} />
            </div>
          )}
          {screen === 'error' && (
            <div className="fc-panel" role="alert" data-error={errorKind}>
              <h2>{copy.title}</h2>
              <p>{copy.body}</p>
              {copy.retry && <button type="button" className="fc-btn fc-primary" onClick={() => startCamera()}>Try again</button>}
              <PhotoButton onFile={startPhoto} />
            </div>
          )}
          {DEBUG && hud && <pre className="fc-hud">{JSON.stringify({ ...hud, patches: hud.patches.length, timeline: hud.timeline.slice(-4) }, null, 1)}</pre>}
        </section>
        <aside className="fc-controls" aria-label="Collage controls">
          <label className="fc-field">
            <span>Preset</span>
            <select value={preset} onChange={(e) => applyPreset(e.target.value)}>
              {Object.entries(PRESETS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
              {preset === 'custom' && <option value="custom">Custom</option>}
            </select>
          </label>
          {COUNT_KEYS.map(([kind, label]) => (
            <label key={kind} className="fc-field">
              <span>{label} <output>{counts[kind]}</output></span>
              <input type="range" min={COUNT_LIMITS[kind].min} max={COUNT_LIMITS[kind].max} step="1" value={counts[kind]} onChange={(e) => setCount(kind, e.target.value)} data-testid={`fc-count-${kind}`} />
            </label>
          ))}
          <label className="fc-field">
            <span>Glitch <output>{Math.round(glitch * 100)}</output></span>
            <input type="range" min="0" max="100" step="1" value={Math.round(glitch * 100)} onChange={(e) => { setPreset('custom'); setGlitch(Number(e.target.value) / 100); }} />
          </label>
          <div className="fc-row">
            <button type="button" className="fc-btn" onClick={reroll} data-testid="fc-random">Random</button>
            <input className="fc-seed" value={seedText} onChange={(e) => setSeedText(e.target.value)} onBlur={commitSeed} onKeyDown={(e) => e.key === 'Enter' && commitSeed()} aria-label="Seed" maxLength={6} data-testid="fc-seed" />
          </div>
          <div className="fc-row">
            <button type="button" className="fc-btn" onClick={savePng} disabled={!active}>PNG</button>
            <button type="button" className="fc-btn" onClick={toggleRecord} disabled={!active} aria-pressed={recording}>{recording ? 'Stop rec' : 'Record'}</button>
          </div>
          {mode === 'camera' && cameras.length > 1 && active && <button type="button" className="fc-btn" onClick={switchCamera}>Switch camera</button>}
          <button type="button" className="fc-btn fc-stop" onClick={stopAll} disabled={!active && screen !== 'loading'} data-testid="fc-stop">Stop camera</button>
          {notice && <p className="fc-small" role="status">{notice}</p>}
        </aside>
      </main>
    </div>
  );
}

function PhotoButton({ onFile }) {
  return (
    <label className="fc-btn fc-file">
      Use a photo
      <input type="file" accept="image/*" onChange={(e) => onFile(e.target.files?.[0])} data-testid="fc-photo" />
    </label>
  );
}
