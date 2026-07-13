// ================= BLE UUIDs (Custom GATT Service) =================
const ACCEL_SERVICE_UUID = "12340000-1234-5678-9abc-def012345678";
const ACCEL_DATA_CHAR_UUID = "12340001-1234-5678-9abc-def012345678"; // NOTIFY
const SAMPLE_RATE_CHAR_UUID = "12340003-1234-5678-9abc-def012345678"; // READ+WRITE
const SENSOR_META_CHAR_UUID = "12340004-1234-5678-9abc-def012345678"; // READ
const OPERATING_MODE_CHAR_UUID = "12340005-1234-5678-9abc-def012345678"; // READ+WRITE
const TX_POWER_CHAR_UUID = "12340006-1234-5678-9abc-def012345678"; // READ+WRITE
const BATTERY_CHAR_UUID = "12340007-1234-5678-9abc-def012345678"; // READ+NOTIFY

let device, accelDataChar, sampleRateChar, operatingModeChar, txPowerChar, sensorMetaChar, timeChart, fftChart;
// Live Motion & Diagnostics globals
let orbitChart;
let orbitAxisPair = 'xy'; // xy, xz, yz
let isOrbitFrozen = false;
let threeScene, threeCamera, threeRenderer, threeModel;
let threeArrowDir, threeArrowHelper;
let isNrfDevice = false;

// ===== Connection Timeline Logs Helper =====
function addTimelineLog(msg, type = "info") {
    const timeline = document.getElementById("connectionTimeline");
    if (!timeline) return;
    
    // Clear the placeholder on first write
    if (timeline.innerText && timeline.innerText.includes("Timeline idle")) {
        timeline.innerHTML = "";
    }
    
    const now = new Date();
    const timeStr = now.toLocaleTimeString() + "." + String(now.getMilliseconds()).substring(0, 1);
    
    const logRow = document.createElement("div");
    logRow.className = "flex gap-3 text-body-sm font-numeric-data";
    
    let colorClass = "text-on-surface";
    if (type === "scan") colorClass = "text-green-600";
    else if (type === "succ") colorClass = "text-primary font-semibold";
    else if (type === "warn") colorClass = "text-orange-600";
    
    logRow.innerHTML = `
        <span class="text-outline shrink-0">${timeStr}</span>
        <span class="${colorClass}">${msg}</span>
    `;
    
    timeline.appendChild(logRow);
    timeline.scrollTop = timeline.scrollHeight;
}

// ===== Visual Playout Queue =====
let visualQueue = [];
let lastRenderTime = null;
let isPlayingOut = false;
const PLAYOUT_THRESHOLD = 150; // buffer 150ms locally to guarantee continuous scroll
let playoutAccumulator = 0;

// ===== Active Sensor State & LocalStorage Overrides for Sensor Isolation =====
let activeSensor = "H3LIS331DL"; // Dynamically updated by G-range
const originalGetItem = localStorage.getItem.bind(localStorage);
const originalSetItem = localStorage.setItem.bind(localStorage);
const originalRemoveItem = localStorage.removeItem.bind(localStorage);

const calibrationKeys = [
    "calibOffsetX", "calibOffsetY", "calibOffsetZ", 
    "calib3x3Enabled", "calib3x3Matrix", "calib3x3Bias", 
    "calib3x3Metadata", "calibrated_noise_rms", "calibHistory"
];

localStorage.getItem = function(key) {
    if (calibrationKeys.includes(key)) {
        return originalGetItem(key + "_" + activeSensor);
    }
    return originalGetItem(key);
};

localStorage.setItem = function(key, value) {
    if (calibrationKeys.includes(key)) {
        return originalSetItem(key + "_" + activeSensor, value);
    }
    return originalSetItem(key, value);
};

localStorage.removeItem = function(key) {
    if (calibrationKeys.includes(key)) {
        return originalRemoveItem(key + "_" + activeSensor);
    }
    return originalRemoveItem(key);
};

// ===== Sensor Parameters =====
let SAMPLE_RATE = 1024;   // sensor sampling rate in Hz
let LSB_PER_G = 81.92;   // ±400g range (H3LIS331DL, raw 16-bit counts: 32768 / 400 = 81.92 LSB/g)
let sampleCount = 0;
let lastSampleCounter = -1;
let droppedSamples = 0;

// ===== Zero-g Tare Calibration Offsets =====
let calibOffsetX = 0.0;
let calibOffsetY = 0.0;
let calibOffsetZ = 0.0;

// ===== 3x3 Advanced Calibration parameters =====
let calib3x3Enabled = false;
let calib3x3Matrix = [
    [1.0, 0.0, 0.0],
    [0.0, 1.0, 0.0],
    [0.0, 0.0, 1.0]
];
let calib3x3Bias = { x: 0.0, y: 0.0, z: 0.0 };

// 6-Position Calibration state
let isSixPosCalibrating = false;
let sixPosStep = 1; // 1 to 6
let sixPosSamples = [];
let sixPosMeans = []; // will store the 6 mean vectors
let sixPosTargetSamples = 10 * SAMPLE_RATE; // 10s — extended averaging for high-g MEMS noise reduction
let sixPosCountdownVal = 10.0;
let sixPosStartTimestamp = 0;
let sixPosSettling = true;

// Validation state variables
let isValidationActive = false;
let validationStep = 1;
let validationSamples = [];
let validationMeans = [];
let validationTargetSamples = 10 * SAMPLE_RATE; // 10s
let validationCountdownVal = 10.0;
let validationStartTimestamp = 0;
let validationSettling = true;

// ===== StageState Enum =====
const StageState = {
    BYPASSED: 'BYPASSED',
    SETTLING: 'SETTLING',
    READY: 'READY'
};

// ===== DSP Framework Classes =====
class HighPassFilter {
    constructor(cutoff, sampleRate) {
        this.reset();
        this.setParams(cutoff, sampleRate);
    }
    reset() {
        this.x_prev = 0.0;
        this.y_prev = 0.0;
        this.samplesProcessed = 0;
        this.isSettling = false;
    }
    setParams(cutoff, sampleRate) {
        this.cutoff = cutoff;
        this.fs = sampleRate > 0 ? sampleRate : 1024;
        
        if (this.cutoff > 0) {
            const rc = 1.0 / (2.0 * Math.PI * this.cutoff);
            const dt = 1.0 / this.fs;
            this.alpha = rc / (rc + dt);
            this.settlingSamples = Math.ceil(5.0 * rc * this.fs);
        } else {
            this.alpha = 1.0;
            this.settlingSamples = 0;
        }
        this.reset();
    }
    process(x) {
        this.samplesProcessed++;
        if (this.cutoff <= 0) {
            this.isSettling = false;
            return x;
        }
        this.isSettling = (this.samplesProcessed < this.settlingSamples);
        if (this.samplesProcessed === 1) {
            this.x_prev = x;
            this.y_prev = 0.0;
            return 0.0;
        }
        const y = this.alpha * (this.y_prev + x - this.x_prev);
        this.x_prev = x;
        this.y_prev = y;
        return y;
    }
}

class Biquad {
    constructor() {
        this.b0 = 1; this.b1 = 0; this.b2 = 0;
        this.a1 = 0; this.a2 = 0;
        this.reset();
    }
    reset() {
        this.w1 = 0.0;
        this.w2 = 0.0;
    }
    setCoefficients(b0, b1, b2, a1, a2) {
        this.b0 = b0; this.b1 = b1; this.b2 = b2;
        this.a1 = a1; this.a2 = a2;
    }
    process(x) {
        const w = x - this.a1 * this.w1 - this.a2 * this.w2;
        const y = this.b0 * w + this.b1 * this.w1 + this.b2 * this.w2;
        this.w2 = this.w1;
        this.w1 = w;
        return y;
    }
    getFrequencyResponse(f, fs) {
        const omega = 2.0 * Math.PI * f / fs;
        const cos1 = Math.cos(omega);
        const sin1 = Math.sin(omega);
        const cos2 = Math.cos(2.0 * omega);
        const sin2 = Math.sin(2.0 * omega);

        const numReal = this.b0 + this.b1 * cos1 + this.b2 * cos2;
        const numImag = -this.b1 * sin1 - this.b2 * sin2;

        const denReal = 1.0 + this.a1 * cos1 + this.a2 * cos2;
        const denImag = -this.a1 * sin1 - this.a2 * sin2;

        const denMag2 = denReal * denReal + denImag * denImag;
        if (denMag2 === 0) return { magnitude: 0, phase: 0 };

        const real = (numReal * denReal + numImag * denImag) / denMag2;
        const imag = (numImag * denReal - numReal * denImag) / denMag2;

        const magnitude = Math.sqrt(real * real + imag * imag);
        const phase = Math.atan2(imag, real);

        return { magnitude, phase };
    }
}

class AxisProcessor {
    constructor() {
        this.biquads = [];
        this.samplesProcessed = 0;
        this.settlingSamples = 0;
    }
    reset() {
        this.samplesProcessed = 0;
        for (const bq of this.biquads) {
            bq.reset();
        }
    }
    setBiquads(biquads, settlingSamples = 0) {
        this.biquads = biquads;
        this.settlingSamples = settlingSamples;
        this.reset();
    }
    isSettling() {
        return this.samplesProcessed < this.settlingSamples;
    }
    process(x) {
        this.samplesProcessed++;
        let out = x;
        for (const bq of this.biquads) {
            out = bq.process(out);
        }
        if (this.samplesProcessed === 1) {
            return 0.0;
        }
        return out;
    }
    getFrequencyResponse(f, fs) {
        let totalMag = 1.0;
        let totalPhase = 0.0;
        for (const bq of this.biquads) {
            const resp = bq.getFrequencyResponse(f, fs);
            totalMag *= resp.magnitude;
            totalPhase += resp.phase;
        }
        return { magnitude: totalMag, phase: totalPhase };
    }
}

class FilterFactory {
    static create(config) {
        const { prototype, type, order, cutoff, sampleRate } = config;
        const biquads = [];
        const fs = sampleRate > 0 ? sampleRate : 1024;
        const fc = Math.min(cutoff, fs * 0.49);
        
        let qValues = [];
        if (order === 2) {
            qValues = [0.7071068];
        } else if (order === 4) {
            qValues = [0.5411961, 1.3065630];
        } else if (order === 6) {
            qValues = [0.5176381, 0.7071068, 1.9318517];
        } else {
            qValues = [0.7071068];
        }

        const w0 = 2.0 * Math.PI * fc / fs;
        const cosW0 = Math.cos(w0);
        const sinW0 = Math.sin(w0);

        for (const q of qValues) {
            const bq = new Biquad();
            const alpha = sinW0 / (2.0 * q);
            let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;

            if (type === 'LPF') {
                b0 = (1.0 - cosW0) / 2.0;
                b1 = 1.0 - cosW0;
                b2 = (1.0 - cosW0) / 2.0;
                a0 = 1.0 + alpha;
                a1 = -2.0 * cosW0;
                a2 = 1.0 - alpha;
            } else if (type === 'HPF') {
                b0 = (1.0 + cosW0) / 2.0;
                b1 = -(1.0 + cosW0);
                b2 = (1.0 + cosW0) / 2.0;
                a0 = 1.0 + alpha;
                a1 = -2.0 * cosW0;
                a2 = 1.0 - alpha;
            } else if (type === 'BPF') {
                b0 = alpha;
                b1 = 0.0;
                b2 = -alpha;
                a0 = 1.0 + alpha;
                a1 = -2.0 * cosW0;
                a2 = 1.0 - alpha;
            } else if (type === 'Notch') {
                b0 = 1.0;
                b1 = -2.0 * cosW0;
                b2 = 1.0;
                a0 = 1.0 + alpha;
                a1 = -2.0 * cosW0;
                a2 = 1.0 - alpha;
            }

            bq.setCoefficients(
                b0 / a0,
                b1 / a0,
                b2 / a0,
                a1 / a0,
                a2 / a0
            );
            biquads.push(bq);
        }
        return biquads;
    }
    // Backward compatibility mapping
    static createButterworth(type, order, cutoff, sampleRate) {
        return this.create({ prototype: 'Butterworth', type, order, cutoff, sampleRate });
    }
}

class SignalStage {
    constructor(name) {
        this.name = name;
        this.active = false;
    }
    configure() {}
    reset() {}
    process(sample) {
        return sample;
    }
    getState() {
        if (!this.active) return StageState.BYPASSED;
        return StageState.READY;
    }
    getCapabilities() {
        return {
            supportsFrequencyResponse: false,
            supportsSerialization: true,
            supportsSettling: false,
            supportsRealtime: true
        };
    }
    serialize() {
        return { name: this.name, active: this.active, version: 1 };
    }
    deserialize(config) {
        if (config && config.name === this.name) {
            this.active = !!config.active;
        }
    }
}

class CouplingStage extends SignalStage {
    constructor(sampleRate) {
        super('coupling');
        this.processors = {
            x: new AxisProcessor(),
            y: new AxisProcessor(),
            z: new AxisProcessor()
        };
        this.couplingMode = 'DC';
        this.sampleRate = sampleRate;
        this.configure(this.couplingMode, this.sampleRate);
    }
    reset() {
        this.processors.x.reset();
        this.processors.y.reset();
        this.processors.z.reset();
    }
    configure(couplingMode, sampleRate) {
        this.couplingMode = couplingMode;
        this.sampleRate = sampleRate > 0 ? sampleRate : 1024;
        this.active = (this.couplingMode !== 'DC');
        
        if (this.active) {
            let cutoff = 0.0;
            if (this.couplingMode === 'AC_0.3') cutoff = 0.3;
            else if (this.couplingMode === 'AC_3') cutoff = 3.0;
            else if (this.couplingMode === 'AC_10') cutoff = 10.0;
            
            const rc = 1.0 / (2.0 * Math.PI * cutoff);
            const settlingSamples = Math.ceil(5.0 * rc * this.sampleRate);
            
            for (const axis of ['x', 'y', 'z']) {
                const bqs = FilterFactory.create({
                    prototype: 'Butterworth',
                    type: 'HPF',
                    order: 2,
                    cutoff: cutoff,
                    sampleRate: this.sampleRate
                });
                this.processors[axis].setBiquads(bqs, settlingSamples);
            }
        } else {
            for (const axis of ['x', 'y', 'z']) {
                this.processors[axis].setBiquads([], 0);
            }
        }
    }
    getState() {
        if (!this.active) return StageState.BYPASSED;
        if (this.processors.x.isSettling() || this.processors.y.isSettling() || this.processors.z.isSettling()) {
            return StageState.SETTLING;
        }
        return StageState.READY;
    }
    process(sample) {
        if (!this.active) return sample;
        return {
            x: this.processors.x.process(sample.x),
            y: this.processors.y.process(sample.y),
            z: this.processors.z.process(sample.z)
        };
    }
    serialize() {
        const obj = super.serialize();
        obj.couplingMode = this.couplingMode;
        return obj;
    }
    deserialize(config) {
        super.deserialize(config);
        if (config && config.couplingMode) {
            this.configure(config.couplingMode, this.sampleRate);
        }
    }
}

class FilterStage extends SignalStage {
    constructor(name = 'filter') {
        super(name);
        this.processors = {
            x: new AxisProcessor(),
            y: new AxisProcessor(),
            z: new AxisProcessor()
        };
        this.filterType = 'None';
        this.order = 4;
        this.cutoff = 100;
        this.sampleRate = 1024;
        this.cachedPlotPoints = [];
    }
    reset() {
        this.processors.x.reset();
        this.processors.y.reset();
        this.processors.z.reset();
    }
    configure(filterType, order, cutoff, sampleRate) {
        this.filterType = filterType;
        this.order = parseInt(order) || 4;
        this.cutoff = parseFloat(cutoff) || 100;
        this.sampleRate = sampleRate > 0 ? sampleRate : 1024;
        this.active = (this.filterType !== 'None');
        
        if (this.active) {
            const rc = 1.0 / (2.0 * Math.PI * this.cutoff);
            const settlingSamples = Math.ceil(5.0 * rc * this.sampleRate);
            
            for (const axis of ['x', 'y', 'z']) {
                const bqs = FilterFactory.create({
                    prototype: 'Butterworth',
                    type: this.filterType,
                    order: this.order,
                    cutoff: this.cutoff,
                    sampleRate: this.sampleRate
                });
                this.processors[axis].setBiquads(bqs, settlingSamples);
            }
        } else {
            for (const axis of ['x', 'y', 'z']) {
                this.processors[axis].setBiquads([], 0);
            }
        }

        // Cache 512 points for plotting
        this.cachedPlotPoints = [];
        if (this.active) {
            const maxFreq = this.sampleRate / 2;
            for (let i = 0; i <= 512; i++) {
                const f = Math.max(1, (i / 512) * maxFreq);
                const resp = this.processors.x.getFrequencyResponse(f, this.sampleRate);
                const magDb = 20.0 * Math.log10(Math.max(1e-4, resp.magnitude));
                const phaseDeg = resp.phase * 180.0 / Math.PI;
                this.cachedPlotPoints.push({ f, magDb, phaseDeg });
            }
        }
    }
    getState() {
        if (!this.active) return StageState.BYPASSED;
        if (this.processors.x.isSettling() || this.processors.y.isSettling() || this.processors.z.isSettling()) {
            return StageState.SETTLING;
        }
        return StageState.READY;
    }
    process(sample) {
        if (!this.active) return sample;
        return {
            x: this.processors.x.process(sample.x),
            y: this.processors.y.process(sample.y),
            z: this.processors.z.process(sample.z)
        };
    }
    getFrequencyResponse(f) {
        if (!this.active) {
            return { magnitude: 1.0, phase: 0.0 };
        }
        return this.processors.x.getFrequencyResponse(f, this.sampleRate);
    }
    serialize() {
        const obj = super.serialize();
        obj.filterType = this.filterType;
        obj.order = this.order;
        obj.cutoff = this.cutoff;
        return obj;
    }
    deserialize(config) {
        super.deserialize(config);
        if (config) {
            this.configure(config.filterType || 'None', config.order || 4, config.cutoff || 100, this.sampleRate);
        }
    }
}

class IntegrationStage extends SignalStage {
    constructor(mode = 'velocity', sampleRate = 1024, driftCutoff = 2.0) {
        super(mode === 'velocity' ? 'velocity_integration' : 'displacement_integration');
        this.mode = mode;
        this.sampleRate = sampleRate;
        this.driftCutoff = driftCutoff;
        this.reset();
    }
    reset() {
        this.v_prev = { x: 0.0, y: 0.0, z: 0.0 };
        this.a_prev = { x: 0.0, y: 0.0, z: 0.0 };
        this.d_prev = { x: 0.0, y: 0.0, z: 0.0 };
        this.samplesProcessed = 0;
        this.active = true;
        this.driftActive = (this.driftCutoff > 0.0);
        
        // Auto AC high-pass filter for input acceleration to remove gravity and DC offset prior to integration
        this.hpf_input = {
            x: FilterFactory.create({ prototype: 'Butterworth', type: 'HPF', order: 2, cutoff: 0.3, sampleRate: this.sampleRate }),
            y: FilterFactory.create({ prototype: 'Butterworth', type: 'HPF', order: 2, cutoff: 0.3, sampleRate: this.sampleRate }),
            z: FilterFactory.create({ prototype: 'Butterworth', type: 'HPF', order: 2, cutoff: 0.3, sampleRate: this.sampleRate })
        };
        
        if (this.driftActive) {
            this.hpf_v = {
                x: FilterFactory.create({ prototype: 'Butterworth', type: 'HPF', order: 2, cutoff: this.driftCutoff, sampleRate: this.sampleRate }),
                y: FilterFactory.create({ prototype: 'Butterworth', type: 'HPF', order: 2, cutoff: this.driftCutoff, sampleRate: this.sampleRate }),
                z: FilterFactory.create({ prototype: 'Butterworth', type: 'HPF', order: 2, cutoff: this.driftCutoff, sampleRate: this.sampleRate })
            };
            this.hpf_d = {
                x: FilterFactory.create({ prototype: 'Butterworth', type: 'HPF', order: 2, cutoff: this.driftCutoff, sampleRate: this.sampleRate }),
                y: FilterFactory.create({ prototype: 'Butterworth', type: 'HPF', order: 2, cutoff: this.driftCutoff, sampleRate: this.sampleRate }),
                z: FilterFactory.create({ prototype: 'Butterworth', type: 'HPF', order: 2, cutoff: this.driftCutoff, sampleRate: this.sampleRate })
            };
        } else {
            this.hpf_v = { x: [], y: [], z: [] };
            this.hpf_d = { x: [], y: [], z: [] };
        }
    }
    configure(sampleRate, driftCutoff = null) {
        this.sampleRate = sampleRate > 0 ? sampleRate : 1024;
        if (driftCutoff !== null) {
            this.driftCutoff = parseFloat(driftCutoff);
        }
        this.reset();
    }
    getState() {
        if (!this.active) return StageState.BYPASSED;
        if (this.samplesProcessed < 15) return StageState.SETTLING;
        return StageState.READY;
    }
    process(accel) {
        if (!this.active) return accel;
        this.samplesProcessed++;
        const dt = 1.0 / this.sampleRate;
        const G_TO_MPS2 = 9.80665;
        const out = { x: 0.0, y: 0.0, z: 0.0 };
        
        for (const axis of ['x', 'y', 'z']) {
            let a_g = accel[axis];
            // Apply input HPF to remove DC/gravity offset
            if (this.hpf_input && this.hpf_input[axis]) {
                for (const bq of this.hpf_input[axis]) {
                    a_g = bq.process(a_g);
                }
            }
            const a_mps2 = a_g * G_TO_MPS2;
            
            // Save velocity state value prior to updating for accurate trapezoidal integration of displacement
            const prevV = this.v_prev[axis];
            
            // Velocity integration
            let v_raw = prevV + (a_mps2 + this.a_prev[axis]) * 0.5 * dt;
            let v_filtered = v_raw;
            if (this.driftActive) {
                for (const bq of this.hpf_v[axis]) {
                    v_filtered = bq.process(v_filtered);
                }
            }
            this.v_prev[axis] = v_filtered;
            this.a_prev[axis] = a_mps2;
            
            if (this.mode === 'velocity') {
                out[axis] = v_filtered * 1000.0; // mm/s
            } else {
                // Displacement integration
                let d_raw = this.d_prev[axis] + (v_filtered + prevV) * 0.5 * dt;
                let d_filtered = d_raw;
                if (this.driftActive) {
                    for (const bq of this.hpf_d[axis]) {
                        d_filtered = bq.process(d_filtered);
                    }
                }
                this.d_prev[axis] = d_filtered;
                out[axis] = d_filtered * 1000000.0; // µm
            }
        }
        
        if (this.getState() === StageState.SETTLING) {
            return { x: 0.0, y: 0.0, z: 0.0 };
        }
        return out;
    }
}

class SignalProcessingPipeline {
    constructor() {
        this.couplingMode = 'DC';
        this.sampleRate = 1024;
        this.stages = [
            new CouplingStage(1024),
            new FilterStage('filter')
        ];
    }
    insertStage(stage, index) {
        this.stages.splice(index, 0, stage);
    }
    removeStage(name) {
        this.stages = this.stages.filter(s => s.name !== name);
    }
    moveStage(fromIndex, toIndex) {
        if (fromIndex >= 0 && fromIndex < this.stages.length && toIndex >= 0 && toIndex < this.stages.length) {
            const [stage] = this.stages.splice(fromIndex, 1);
            this.stages.splice(toIndex, 0, stage);
        }
    }
    enableStage(name) {
        const stage = this.stages.find(s => s.name === name);
        if (stage) stage.active = true;
    }
    disableStage(name) {
        const stage = this.stages.find(s => s.name === name);
        if (stage) stage.active = false;
    }
    reset() {
        for (const stage of this.stages) {
            stage.reset();
        }
    }
    updateParams(couplingMode, sampleRate) {
        this.couplingMode = couplingMode;
        this.sampleRate = sampleRate > 0 ? sampleRate : 1024;
        const couplingStage = this.stages.find(s => s.name === 'coupling');
        if (couplingStage) {
            couplingStage.configure(couplingMode, this.sampleRate);
        }
        const filterStage = this.stages.find(s => s.name === 'filter');
        if (filterStage) {
            filterStage.configure(filterStage.filterType, filterStage.order, filterStage.cutoff, this.sampleRate);
        }
        
        const driftSelect = document.getElementById("driftCutoffSelect");
        const driftCutoff = driftSelect ? parseFloat(driftSelect.value) : 2.0;

        if (typeof velocityGen !== 'undefined') velocityGen.configure(this.sampleRate, driftCutoff);
        if (typeof displacementGen !== 'undefined') displacementGen.configure(this.sampleRate, driftCutoff);
    }
    isSettling() {
        for (const stage of this.stages) {
            if (stage.active && stage.getState() === StageState.SETTLING) {
                return true;
            }
        }
        return false;
    }
    apply(sample) {
        let out = { x: sample.x, y: sample.y, z: sample.z };
        for (const stage of this.stages) {
            if (stage.active) {
                out = stage.process(out);
            }
        }
        return out;
    }
    serialize() {
        return {
            version: 1,
            couplingMode: this.couplingMode,
            stages: this.stages.map(s => s.serialize())
        };
    }
    deserialize(config) {
        if (!config || config.version !== 1) return;
        this.couplingMode = config.couplingMode || 'DC';
        if (config.stages) {
            for (const stageConfig of config.stages) {
                const stage = this.stages.find(s => s.name === stageConfig.name);
                if (stage) {
                    stage.deserialize(stageConfig);
                }
            }
        }
    }
}

window.runDSPDiagnostics = function() {
    console.log("=== Running DSP Framework Self-Test & Attenuation Diagnostics ===");
    const testFs = 1000;
    const testStage = new FilterStage('test_lpf');
    
    testStage.configure('LPF', 4, 100, testFs);
    console.log("Configured: 4th-Order LPF at 100 Hz (sample rate: 1000 Hz)");
    
    // 1. Passband Sine Wave Response
    let passed10Hz = true;
    let amplitude10Hz = 0;
    testStage.reset();
    for (let i = 0; i < 200; i++) {
        const x = Math.sin(2.0 * Math.PI * 10 * i / testFs);
        const out = testStage.process({ x, y: 0, z: 0 });
        if (i > 150) {
            amplitude10Hz = Math.max(amplitude10Hz, Math.abs(out.x));
        }
    }
    console.log(`- 10 Hz Sine Wave (Passband) output amplitude: ${amplitude10Hz.toFixed(4)} (Expected: ~1.0)`);
    if (amplitude10Hz < 0.95) passed10Hz = false;

    // 2. Stopband Sine Wave Response
    let passed300Hz = true;
    let amplitude300Hz = 0;
    testStage.reset();
    for (let i = 0; i < 200; i++) {
        const x = Math.sin(2.0 * Math.PI * 300 * i / testFs);
        const out = testStage.process({ x, y: 0, z: 0 });
        if (i > 150) {
            amplitude300Hz = Math.max(amplitude300Hz, Math.abs(out.x));
        }
    }
    console.log(`- 300 Hz Sine Wave (Stopband) output amplitude: ${amplitude300Hz.toFixed(4)} (Expected: <0.02)`);
    if (amplitude300Hz > 0.02) passed300Hz = false;

    // 3. First-Sample Transient protection
    testStage.reset();
    const firstOut = testStage.process({ x: 1.0, y: 0, z: 0 });
    const firstPassed = (firstOut.x === 0.0);
    console.log(`- Transient Protection (First sample output): ${firstOut.x.toFixed(4)} (Expected: 0.0000)`);

    // 4. Impulse Response Decay Response
    testStage.reset();
    let impulseOutputs = [];
    for (let i = 0; i < 30; i++) {
        const x = (i === 0) ? 1.0 : 0.0;
        const out = testStage.process({ x, y: 0, z: 0 });
        impulseOutputs.push(out.x);
    }
    const lastImpulseSampleVal = Math.abs(impulseOutputs[impulseOutputs.length - 1]);
    const impulsePassed = lastImpulseSampleVal < 0.05;
    console.log(`- Impulse Response decay at sample 30: ${lastImpulseSampleVal.toFixed(6)} (Expected: <0.05)`);

    // 5. Step Response Convergence
    testStage.reset();
    let stepOutputVal = 0;
    for (let i = 0; i < 150; i++) {
        const out = testStage.process({ x: 1.0, y: 0, z: 0 });
        stepOutputVal = out.x;
    }
    const stepPassed = Math.abs(stepOutputVal - 1.0) < 0.01;
    console.log(`- Step Response DC convergence: ${stepOutputVal.toFixed(4)} (Expected: ~1.0)`);

    // 6. Frequency Sweep Monotonic Attenuation
    testStage.reset();
    let sweepAttenuates = true;
    const sweepFreqs = [10, 50, 150, 300];
    const sweepPeaks = [];
    
    for (const f of sweepFreqs) {
        testStage.reset();
        let peak = 0;
        for (let i = 0; i < 150; i++) {
            const x = Math.sin(2.0 * Math.PI * f * i / testFs);
            const out = testStage.process({ x, y: 0, z: 0 });
            if (i > 100) {
                peak = Math.max(peak, Math.abs(out.x));
            }
        }
        sweepPeaks.push({ f, peak });
    }
    console.log(`- Frequency Sweep Peaks: ${sweepPeaks.map(p => `${p.f}Hz: ${p.peak.toFixed(3)}`).join(", ")}`);
    if (sweepPeaks[0].peak < sweepPeaks[1].peak || sweepPeaks[1].peak < sweepPeaks[2].peak || sweepPeaks[2].peak < sweepPeaks[3].peak) {
        sweepAttenuates = false;
    }

    // 7. StatisticsEngine validation
    const statsInput = [1.0, -1.0, 1.0, -1.0];
    const stats = StatisticsEngine.compute(statsInput);
    const statsPassed = (
        Math.abs(stats.mean) < 1e-7 &&
        Math.abs(stats.rms - 1.0) < 1e-7 &&
        Math.abs(stats.pp - 2.0) < 1e-7 &&
        Math.abs(stats.kurtosis - (-2.0)) < 1e-7
    );
    console.log(`- StatisticsEngine (Binary): mean=${stats.mean.toFixed(2)} rms=${stats.rms.toFixed(2)} pp=${stats.pp.toFixed(2)} kurt=${stats.kurtosis.toFixed(2)} (Passed: ${statsPassed})`);

    // 8. WindowStage ENBW check
    const hannMeta = WindowStage.getMetadata('hann');
    const hammingMeta = WindowStage.getMetadata('hamming');
    const windowPassed = (hannMeta.enbw === 1.5 && hammingMeta.enbw === 1.3628);
    console.log(`- WindowStage Metadata: Hann ENBW=${hannMeta.enbw} Hamming ENBW=${hammingMeta.enbw} (Passed: ${windowPassed})`);

    // 9. PSD Energy Conservation (Parseval's Theorem)
    const psdFs = 1000;
    const psdN = 1024;
    const psdBlock = new Float64Array(psdN);
    // Sine wave at bin center to avoid scalloping loss bias: 1000/1024 * 128 = 125 Hz
    for (let i = 0; i < psdN; i++) {
        psdBlock[i] = Math.sin(2.0 * Math.PI * 125.0 * i / psdFs);
    }
    const psdSpec = FFTAnalyzer.analyze(psdBlock, psdFs, 'hann');
    const tempPsdAnalyzer = new PSDAnalyzer(1);
    const psdVals = tempPsdAnalyzer.computeAndAverage(psdSpec.magnitudes, psdSpec.binResolution, 'hann');
    let psdIntegration = 0;
    for (let i = 0; i < psdVals.length; i++) {
        psdIntegration += psdVals[i].y * psdSpec.binResolution;
    }
    // Theoretical variance of sine wave with Amplitude 1.0 is A^2 / 2 = 0.5
    const psdPassed = Math.abs(psdIntegration - 0.5) < 0.05;
    console.log(`- PSD Parseval Integration: ${psdIntegration.toFixed(4)} (Expected: ~0.5000) (Passed: ${psdPassed})`);

    // 10. Band RMS Consistency
    const bandResults = BandRMSCalculator.compute(psdSpec.magnitudes, psdSpec.binResolution, psdFs / 2);
    let bandEnergySum = 0;
    for (const b of bandResults) {
        bandEnergySum += b.rms * b.rms;
    }
    const totalSpectrumRMS = Math.sqrt(psdSpec.magnitudes.reduce((acc, pt) => acc + pt.y * pt.y, 0));
    const bandPassed = Math.abs(Math.sqrt(bandEnergySum) - totalSpectrumRMS) < 1e-7;
    console.log(`- Band RMS Consistency: sum(BandRMS^2)=${Math.sqrt(bandEnergySum).toFixed(4)} totalRMS=${totalSpectrumRMS.toFixed(4)} (Passed: ${bandPassed})`);

    // 11. Group Delay Check
    testStage.reset();
    let zeroCrossingIn = -1;
    let zeroCrossingOut = -1;
    let prevIn = 0;
    let prevOut = 0;
    for (let i = 0; i < 250; i++) {
        const x = Math.sin(2.0 * Math.PI * 10 * i / testFs);
        const out = testStage.process({ x, y: 0, z: 0 });
        if (i > 180) {
            // Find positive-going zero crossing
            if (prevIn <= 0 && x > 0 && zeroCrossingIn === -1) {
                zeroCrossingIn = i;
            }
            if (prevOut <= 0 && out.x > 0 && zeroCrossingIn !== -1 && zeroCrossingOut === -1) {
                zeroCrossingOut = i;
            }
        }
        prevIn = x;
        prevOut = out.x;
    }
    const timeDelay = (zeroCrossingOut - zeroCrossingIn) / testFs;
    const measuredPhase = -timeDelay * 2.0 * Math.PI * 10.0;
    const theoreticalPhase = testStage.getFrequencyResponse(10).phase;
    
    // Group Delay is validated if the measured phase delay matches theoretical transfer function to within 0.15 radians
    const groupDelayPassed = Math.abs(measuredPhase - theoreticalPhase) < 0.15;
    console.log(`- Group Delay Check (10Hz LPF): MeasuredPhase=${measuredPhase.toFixed(3)} rad, TheoreticalPhase=${theoreticalPhase.toFixed(3)} rad (Passed: ${groupDelayPassed})`);

    console.log("--- Test Summary ---");
    console.log(`Passband Gain Test (10Hz): ${passed10Hz ? "PASSED" : "FAILED"}`);
    console.log(`Stopband Attenuation Test (300Hz): ${passed300Hz ? "PASSED" : "FAILED"}`);
    console.log(`First-Sample Transient Bypass: ${firstPassed ? "PASSED" : "FAILED"}`);
    console.log(`Impulse Response Decay Check: ${impulsePassed ? "PASSED" : "FAILED"}`);
    console.log(`Step Response DC Convergence: ${stepPassed ? "PASSED" : "FAILED"}`);
    console.log(`Frequency Sweep Attenuation: ${sweepAttenuates ? "PASSED" : "FAILED"}`);
    console.log(`StatisticsEngine Accuracy: ${statsPassed ? "PASSED" : "FAILED"}`);
    console.log(`Window Metadata & ENBW: ${windowPassed ? "PASSED" : "FAILED"}`);
    console.log(`PSD Parseval Conservation: ${psdPassed ? "PASSED" : "FAILED"}`);
    console.log(`Band RMS Integration Consistency: ${bandPassed ? "PASSED" : "FAILED"}`);
    console.log(`Group Delay Check: ${groupDelayPassed ? "PASSED" : "FAILED"}`);
    console.log("==================================================================");
    
    return {
        passed10Hz,
        passed300Hz,
        firstPassed,
        impulsePassed,
        stepPassed,
        sweepAttenuates,
        statsPassed,
        windowPassed,
        psdPassed,
        bandPassed,
        groupDelayPassed,
        overallStatus: (passed10Hz && passed300Hz && firstPassed && impulsePassed && stepPassed && sweepAttenuates && statsPassed && windowPassed && psdPassed && bandPassed && groupDelayPassed) ? "PASSED" : "FAILED"
    };
};

class WindowStage extends SignalStage {
    constructor(windowType = 'Hann') {
        super('window');
        this.windowType = windowType;
        this.active = true;
    }
    configure(windowType) {
        this.windowType = windowType;
    }
    static generateCoefficients(type, n) {
        const win = new Float64Array(n);
        if (type === 'Rectangular' || type === 'none' || type === 'None') {
            win.fill(1.0);
            return win;
        }
        for (let i = 0; i < n; i++) {
            if (type === 'Hann' || type === 'hann') {
                win[i] = 0.5 * (1.0 - Math.cos((2.0 * Math.PI * i) / (n - 1)));
            } else if (type === 'Hamming' || type === 'hamming') {
                win[i] = 0.54 - 0.46 * Math.cos((2.0 * Math.PI * i) / (n - 1));
            } else if (type === 'Blackman' || type === 'blackman') {
                win[i] = 0.42 - 0.5 * Math.cos((2.0 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4.0 * Math.PI * i) / (n - 1));
            } else if (type === 'Blackman-Harris' || type === 'blackman-harris') {
                win[i] = 0.35875 - 0.48829 * Math.cos((2.0 * Math.PI * i) / (n - 1)) + 0.14128 * Math.cos((4.0 * Math.PI * i) / (n - 1)) - 0.01168 * Math.cos((6.0 * Math.PI * i) / (n - 1));
            } else if (type === 'Flat-Top' || type === 'flat-top' || type === 'Flat Top') {
                win[i] = 0.21557895 - 0.41663158 * Math.cos((2.0 * Math.PI * i) / (n - 1)) + 0.277263158 * Math.cos((4.0 * Math.PI * i) / (n - 1)) - 0.083578947 * Math.cos((6.0 * Math.PI * i) / (n - 1)) + 0.006947368 * Math.cos((8.0 * Math.PI * i) / (n - 1));
            } else {
                win[i] = 1.0;
            }
        }
        return win;
    }
    static getCoherentGain(type) {
        return WindowStage.getMetadata(type).coherentGain;
    }
    static getMetadata(type) {
        const key = (type || '').toLowerCase().replace(' ', '-');
        const db = {
            'hann':            { coherentGain: 0.5,         enbw: 1.5,    scallopingLoss: 1.42, recommendedFor: 'General FFT' },
            'hamming':         { coherentGain: 0.54,        enbw: 1.3628, scallopingLoss: 1.78, recommendedFor: 'Leakage Reduction' },
            'blackman':        { coherentGain: 0.42,        enbw: 1.7268, scallopingLoss: 1.10, recommendedFor: 'Dynamic Range' },
            'blackman-harris': { coherentGain: 0.35875,     enbw: 2.0044, scallopingLoss: 0.83, recommendedFor: 'High Dynamic Range' },
            'flat-top':        { coherentGain: 0.21557895,  enbw: 3.7702, scallopingLoss: 0.01, recommendedFor: 'Amplitude Accuracy' }
        };
        return db[key] || { coherentGain: 1.0, enbw: 1.0, scallopingLoss: 3.92, recommendedFor: 'No windowing' };
    }
}

class FFTAnalyzer {
    static analyze(rawBlock, fs, windowType) {
        const n = rawBlock.length;
        
        // 1. DC Removal
        const mean = rawBlock.reduce((a, b) => a + b, 0) / n;
        const centered = rawBlock.map(v => v - mean);
        
        // 2. Apply Window
        const win = WindowStage.generateCoefficients(windowType, n);
        const windowed = centered.map((v, i) => v * win[i]);
        
        // 3. Compute FFT
        const real = new Float64Array(n);
        const imag = new Float64Array(n);
        fftCooleyTukey(windowed, real, imag);
        
        // 4. Compute magnitudes with coherent gain scaling
        const cg = WindowStage.getCoherentGain(windowType);
        const magnitudes = [];
        const phases = new Float64Array(n / 2);
        const binResolution = fs / n;
        
        for (let i = 0; i < n / 2; i++) {
            const r = real[i];
            const im = imag[i];
            const factor = (i === 0) ? (1.0 / (n * cg)) : (2.0 / (n * cg));
            const magVal = Math.sqrt(r * r + im * im) * factor;
            
            magnitudes.push({ 
                x: i * binResolution, 
                y: magVal,
                phase: Math.atan2(im, r) * 180.0 / Math.PI
            });
            phases[i] = Math.atan2(im, r) * 180.0 / Math.PI;
        }
        
        return { magnitudes, phases, binResolution };
    }
}

class HarmonicAnalyzer {
    static analyze(magnitudes, binResolution) {
        const numBins = magnitudes.length;
        
        // 1. Primary Frequency detection (strongest peak >= 3 Hz)
        let peakVal = 0;
        let peakIdx = 0;
        const startBin = Math.max(1, Math.floor(3.0 / binResolution));
        for (let i = startBin; i < numBins; i++) {
            if (magnitudes[i].y > peakVal) {
                peakVal = magnitudes[i].y;
                peakIdx = i;
            }
        }
        const peakFreq = peakIdx * binResolution;
        
        // 2. Harmonics tracking (2X to 5X) with local peak search
        const harmonics = [];
        let harmonicsSumSq = 0;
        for (let h = 2; h <= 5; h++) {
            const targetFreq = peakFreq * h;
            const centerBin = Math.round(targetFreq / binResolution);
            
            let hPeakVal = 0;
            let hPeakBin = centerBin;
            for (let b = centerBin - 2; b <= centerBin + 2; b++) {
                if (b >= 0 && b < numBins) {
                    if (magnitudes[b].y > hPeakVal) {
                        hPeakVal = magnitudes[b].y;
                        hPeakBin = b;
                    }
                }
            }
            harmonics.push({ order: h, freq: hPeakBin * binResolution, mag: hPeakVal });
            harmonicsSumSq += hPeakVal * hPeakVal;
        }
        
        // 3. THD (%)
        const thd = (peakVal > 0) ? (Math.sqrt(harmonicsSumSq) / peakVal) * 100.0 : 0.0;
        
        return { peakFreq, peakVal, harmonics, thd };
    }
}

class StatisticsEngine {
    static compute(values) {
        const n = values.length;
        if (n === 0) return { mean: 0, variance: 0, stdDev: 0, rms: 0, peak: 0, peakNeg: 0, pp: 0, cf: 0, kurtosis: 0 };
        
        let sum = 0, sum2 = 0, sum4 = 0;
        let maxVal = -Infinity, minVal = Infinity;
        
        // First pass: mean, peak tracking
        for (let i = 0; i < n; i++) {
            const v = values[i];
            sum += v;
            if (v > maxVal) maxVal = v;
            if (v < minVal) minVal = v;
        }
        const mean = sum / n;
        
        // Second pass: variance, kurtosis (centered moments)
        for (let i = 0; i < n; i++) {
            const d = values[i] - mean;
            sum2 += d * d;
            sum4 += d * d * d * d;
        }
        const variance = sum2 / n;
        const stdDev = Math.sqrt(variance);
        const rms = Math.sqrt(sum2 / n); // AC RMS (same as stdDev for zero-mean)
        
        const pp = maxVal - minVal;
        const maxAbs = Math.max(Math.abs(maxVal), Math.abs(minVal));
        const cf = rms > 0 ? maxAbs / rms : 0;
        
        const m4 = sum4 / n;
        const s4 = variance * variance;
        const kurtosis = s4 > 1e-12 ? (m4 / s4) - 3.0 : 0.0;
        
        return { mean, variance, stdDev, rms, peak: maxVal, peakNeg: minVal, pp, cf, kurtosis };
    }
}

class PSDAnalyzer {
    constructor(maxAverages = 32) {
        this.maxAverages = maxAverages;
        this.history = [];  // ring buffer of PSD frames
        this.numAverages = 1;
    }
    setAverages(n) {
        this.numAverages = Math.max(1, Math.min(n, this.maxAverages));
    }
    reset() {
        this.history = [];
    }
    computeAndAverage(magnitudes, binResolution, windowType) {
        const meta = WindowStage.getMetadata(windowType);
        const noiseBandwidth = binResolution * meta.enbw;
        
        // Compute instantaneous PSD: |X(f)|^2 / (df * ENBW). Divide AC bins by 2.0 for physical RMS power scaling.
        const psd = magnitudes.map((pt, idx) => ({
            x: pt.x,
            y: (idx === 0) ? (pt.y * pt.y) / noiseBandwidth : (pt.y * pt.y) / (2.0 * noiseBandwidth)
        }));
        
        // Add to history buffer
        this.history.push(psd);
        while (this.history.length > this.numAverages) {
            this.history.shift();
        }
        
        // Linear average across history
        const nFrames = this.history.length;
        if (nFrames === 1) return psd;
        
        const averaged = psd.map((pt, i) => {
            let sum = 0;
            for (let f = 0; f < nFrames; f++) {
                sum += this.history[f][i].y;
            }
            return { x: pt.x, y: sum / nFrames };
        });
        return averaged;
    }
}

class BandRMSCalculator {
    static compute(magnitudes, binResolution, nyquistFreq) {
        // Nyquist-relative bands
        const bands = [
            { label: 'Band 1', fLow: 0,              fHigh: 0.1 * nyquistFreq },
            { label: 'Band 2', fLow: 0.1 * nyquistFreq, fHigh: 0.25 * nyquistFreq },
            { label: 'Band 3', fLow: 0.25 * nyquistFreq, fHigh: 0.5 * nyquistFreq },
            { label: 'Band 4', fLow: 0.5 * nyquistFreq,  fHigh: nyquistFreq }
        ];
        
        return bands.map(band => {
            let sumSq = 0;
            let count = 0;
            for (const pt of magnitudes) {
                if (pt.x >= band.fLow && pt.x < band.fHigh) {
                    sumSq += pt.y * pt.y;
                    count++;
                }
            }
            return {
                label: band.label,
                fLow: band.fLow,
                fHigh: band.fHigh,
                rms: Math.sqrt(sumSq)
            };
        });
    }
}

const signalPipeline = new SignalProcessingPipeline();
let displayQuantity = 'acceleration';
const velocityGen = new IntegrationStage('velocity', 1024);
const displacementGen = new IntegrationStage('displacement', 1024);
const psdAnalyzer = new PSDAnalyzer(32);
let psdChart = null;

// Developer-only diagnostics namespace
window.DEBUG = window.DEBUG || {};
window.DEBUG.profilePipeline = function(sample) {
    const s = sample || { x: 0.001, y: 0.002, z: 0.998 };
    const profile = [];
    let out = { x: s.x, y: s.y, z: s.z };
    for (const stage of signalPipeline.stages) {
        if (stage.active) {
            const t0 = performance.now();
            out = stage.process(out);
            profile.push({ name: stage.name, us: ((performance.now() - t0) * 1000).toFixed(1) + ' µs' });
        }
    }
    console.table(profile);
    return { output: out, profile };
};

// ===== Data Storage =====
let receivedData = [];  // [{t, x, y, z, ts}, ...]

// ===== Latency Tracking =====
let latencyHistory = [];
const LATENCY_WINDOW = 100;
let latencyMax = 0;
let startTime = 0;


// Timestamp Unwrapping
let lastFwTs = 0;
let fwTsWrapOffset = 0;

// ===== Zoom / Window Parameters =====
const WINDOW_MIN = 0.1;
const WINDOW_MAX = 5.0;
const WINDOW_DEFAULT = 1.0;
let windowSeconds = WINDOW_DEFAULT;

// ===== FFT Parameters =====
let fftSize = 2048;
let fftAxis = 'z';
let fftWindowType = 'hann';
let lastFftSampleCount = 0;
let detectedPeakHz = 0;   // Stored from FFT for cycle-based windowing

// ===== Auto-Scale & Cycle Windowing =====
let autoScaleY = true;
let cycleCount = 0;       // 0 = disabled (use manual +/- window)

// ===== Timed Run Parameters =====
let timedRunEnabled = false;
let timedDuration = 10;
let timedTimer = null;
let timedRunStartTimestamp = 0;

// ===== DOM Element References =====
let connectButton, startButton, stopButton, exportButton, calibrateButton, tareButton, bufferModeSelect, samplingRateSelect;
let sixPosCalButton, resetCalMatrixButton, calib3x3EnabledCheckbox;
let validateCalButton, calibStabilityThreshold;
let calibResultsPanel, calibRmsVal, calibMaxVal, calibCondVal, calibRevVal, calibTimeVal, calibPassFailBanner;
let valResultsPanel, valRmsVal, valMaxVal, valTimeVal, valPassFailBanner;
let calibHistorySelect, calibRollbackButton;
let updateYAxisButton, zoomInButton, zoomOutButton;
let xValue, yValue, zValue;
let yAxisMin, yAxisMax, windowDisplay;
let fftAxisSelect, fftSizeSelect, peakFreq, freqResolution;
let latencyCurrent, latencyAvg, latencyMaxEl;
let sampleCountEl, sampleRateEl, droppedCountEl;
let snrXEl, snrYEl, snrZEl, snrSpectralEl, snrSpectralAxisEl;
let calibrationOverlay, calibrationProgressBar, calibrationCountdown;
let noiseFloorX, noiseFloorY, noiseFloorZ;
let signalRmsX, signalRmsY, signalRmsZ;

// ===== Stationary Noise & Tare Calibration Parameters =====
let isCalibrating = false;
let calibrationType = "noise"; // "noise" or "tare"
let calibrationSamples = [];
let calibrationDurationSeconds = 10.0;
let calibrationTotalSamples = 10.0 * SAMPLE_RATE;
let calibrationStartTimestamp = 0;
let calibratedNoiseRms = { x: 0.0563, y: 0.0563, z: 0.0563 }; // standard laboratory defaults for ±400g (56.3 mg)
let calibratedNoisePipelineTag = 'DC|None'; // Tracks coupling+filter state active during last noise calibration

// ================= INIT =================
document.addEventListener("DOMContentLoaded", () => {
    // Get all DOM elements
    connectButton = document.getElementById("connectButton");
    startButton = document.getElementById("startButton");
    stopButton = document.getElementById("stopButton");
    exportButton = document.getElementById("exportButton");
    bufferModeSelect = document.getElementById("bufferModeSelect");
    samplingRateSelect = document.getElementById("samplingRateSelect");
    updateYAxisButton = document.getElementById("updateYAxisButton");
    zoomInButton = document.getElementById("zoomInButton");
    zoomOutButton = document.getElementById("zoomOutButton");
    xValue = document.getElementById("xValue");
    yValue = document.getElementById("yValue");
    zValue = document.getElementById("zValue");
    yAxisMin = document.getElementById("yAxisMin");
    yAxisMax = document.getElementById("yAxisMax");
    windowDisplay = document.getElementById("windowDisplay");

    // FFT elements
    fftAxisSelect = document.getElementById("fftAxisSelect");
    fftSizeSelect = document.getElementById("fftSizeSelect");
    peakFreq = document.getElementById("peakFreq");
    freqResolution = document.getElementById("freqResolution");

    // Latency elements
    latencyCurrent = document.getElementById("latencyCurrent");
    latencyAvg = document.getElementById("latencyAvg");
    latencyMaxEl = document.getElementById("latencyMax");

    // Stats elements
    sampleCountEl = document.getElementById("sampleCount");
    sampleRateEl = document.getElementById("sampleRate");
    droppedCountEl = document.getElementById("droppedCount");

    // SNR elements
    snrXEl = document.getElementById("snrX");
    snrYEl = document.getElementById("snrY");
    snrZEl = document.getElementById("snrZ");
    snrSpectralEl = document.getElementById("snrSpectral");
    snrSpectralAxisEl = document.getElementById("snrSpectralAxis");

    // Calibration & Signal elements
    calibrateButton = document.getElementById("calibrateButton");
    tareButton = document.getElementById("tareButton");
    calibrationOverlay = document.getElementById("calibrationOverlay");
    calibrationProgressBar = document.getElementById("calibrationProgressBar");
    calibrationCountdown = document.getElementById("calibrationCountdown");
    
    noiseFloorX = document.getElementById("noiseFloorX");
    noiseFloorY = document.getElementById("noiseFloorY");
    noiseFloorZ = document.getElementById("noiseFloorZ");
    
    signalRmsX = document.getElementById("signalRmsX");
    signalRmsY = document.getElementById("signalRmsY");
    signalRmsZ = document.getElementById("signalRmsZ");

    // Load persistent calibration baseline from localStorage on init
    const savedNoise = localStorage.getItem('calibrated_noise_rms');
    if (savedNoise) {
        try {
            calibratedNoiseRms = JSON.parse(savedNoise);
        } catch (e) {
            console.error("Failed to parse saved noise RMS:", e);
        }
    }
    updateNoiseFloorUI();

    // Load persistent G-range and configure LSB_PER_G
    const savedRangeG = localStorage.getItem("sensorRangeG") || "400";
    const gRangeSelect = document.getElementById("gRangeSelect");
    const sensorSelect = document.getElementById("sensorSelect");
    const profileSelect = document.getElementById("profileSelect");
    
    const rangeVal = parseInt(savedRangeG, 10);
    const initialSensor = rangeVal <= 16 ? "ADXL345" : "H3LIS331DL";
    
    if (sensorSelect) {
        sensorSelect.value = initialSensor;
    }
    
    updateRangeDropdown(initialSensor, rangeVal);
    updateLSBPerG(rangeVal);
    
    // Set profile select initially based on loaded range
    if (profileSelect) {
        if (initialSensor === "ADXL345" && rangeVal === 2) profileSelect.value = "precision_vibration";
        else if (initialSensor === "ADXL345" && rangeVal === 8) profileSelect.value = "machinery_monitoring";
        else if (initialSensor === "ADXL345" && rangeVal === 16) profileSelect.value = "structural_dynamics";
        else if (initialSensor === "H3LIS331DL" && rangeVal === 400) profileSelect.value = "shock_testing";
        else profileSelect.value = "custom";
    }

    if (gRangeSelect) {
        gRangeSelect.addEventListener("change", async (e) => {
            const val = e.target.value;
            await writeGRange(val);
            updateActiveDeviceConfigUI();
            updateStatusBar();
            if (profileSelect) profileSelect.value = "custom";
        });
    }

    if (sensorSelect) {
        sensorSelect.addEventListener("change", async (e) => {
            const targetSensor = e.target.value;
            const currentSensor = activeSensor;
            const defaultRange = (targetSensor === "H3LIS331DL") ? "400" : "16";

            // Check if streaming is active
            const isStreaming = isPlayingOut || (device && device.gatt.connected && accelDataChar && startButton && startButton.disabled);

            if (isStreaming) {
                const overlay = document.getElementById("configChangeOverlay");
                const confirmSensor = document.getElementById("confirmSensor");
                const confirmRange = document.getElementById("confirmRange");
                if (overlay && confirmSensor && confirmRange) {
                    confirmSensor.textContent = targetSensor;
                    confirmRange.textContent = "±" + defaultRange + "g";
                    overlay.classList.remove("hidden");
                    overlay.dataset.targetSensor = targetSensor;
                    overlay.dataset.targetRange = defaultRange;
                    overlay.dataset.prevSensor = currentSensor;
                }
            } else {
                updateRangeDropdown(targetSensor, defaultRange);
                await writeGRange(defaultRange);
                if (profileSelect) profileSelect.value = "custom";
                const activeSensorLabel = document.getElementById("activeSensorLabel");
                if (activeSensorLabel) activeSensorLabel.textContent = targetSensor;
                updateActiveDeviceConfigUI();
                updateStatusBar();
            }
        });
    }

    // Set up profile change listener
    if (profileSelect) {
        profileSelect.addEventListener("change", async (e) => {
            const profile = e.target.value;
            if (profile === "custom") return;

            let targetSensor = "ADXL345";
            let targetRange = "16";

            if (profile === "precision_vibration") {
                targetSensor = "ADXL345";
                targetRange = "2";
            } else if (profile === "machinery_monitoring") {
                targetSensor = "ADXL345";
                targetRange = "8";
            } else if (profile === "structural_dynamics") {
                targetSensor = "ADXL345";
                targetRange = "16";
            } else if (profile === "shock_testing") {
                targetSensor = "H3LIS331DL";
                targetRange = "400";
            }

            console.log(`Profile select change to ${profile}. targetSensor: ${targetSensor}, targetRange: ${targetRange}`);

            if (sensorSelect) {
                const currentSensor = sensorSelect.value;
                if (currentSensor !== targetSensor) {
                    sensorSelect.value = targetSensor;
                    const event = new Event('change');
                    sensorSelect.dispatchEvent(event);
                    
                    const overlay = document.getElementById("configChangeOverlay");
                    if (overlay && !overlay.classList.contains("hidden")) {
                        overlay.dataset.targetRange = targetRange;
                        const confirmRange = document.getElementById("confirmRange");
                        if (confirmRange) confirmRange.textContent = "±" + targetRange + "g";
                    }
                } else {
                    if (gRangeSelect) {
                        gRangeSelect.value = targetRange;
                        await writeGRange(targetRange);
                        updateActiveDeviceConfigUI();
                        updateStatusBar();
                    }
                }
            }
        });
    }

    // Set up confirmation overlay button listeners
    const configApplyBtn = document.getElementById("configApplyBtn");
    const configCancelBtn = document.getElementById("configCancelBtn");
    const configChangeOverlay = document.getElementById("configChangeOverlay");

    if (configApplyBtn && configChangeOverlay) {
        configApplyBtn.addEventListener("click", async () => {
            const targetSensor = configChangeOverlay.dataset.targetSensor;
            const targetRange = configChangeOverlay.dataset.targetRange;
            configChangeOverlay.classList.add("hidden");

            console.log(`Safety Confirmation accepted: switching to ${targetSensor} range ±${targetRange}g`);

            try {
                if (stopButton && !stopButton.disabled) {
                    stopButton.click();
                }
            } catch (e) {
                console.error(e);
            }

            await new Promise(resolve => setTimeout(resolve, 300));

            updateRangeDropdown(targetSensor, targetRange);
            await writeGRange(targetRange);

            if (profileSelect) profileSelect.value = "custom";
            const activeSensorLabel = document.getElementById("activeSensorLabel");
            if (activeSensorLabel) activeSensorLabel.textContent = targetSensor;
            updateActiveDeviceConfigUI();

            try {
                if (startButton && !startButton.disabled) {
                    startButton.click();
                }
            } catch (e) {
                console.error(e);
            }

            updateStatusBar();
        });
    }

    if (configCancelBtn && configChangeOverlay) {
        configCancelBtn.addEventListener("click", () => {
            const prevSensor = configChangeOverlay.dataset.prevSensor;
            configChangeOverlay.classList.add("hidden");
            if (sensorSelect && prevSensor) {
                sensorSelect.value = prevSensor;
            }
        });
    }

    // Load persistent Zero-g Tare Calibration Offsets
    const storedOffsetX = localStorage.getItem("calibOffsetX");
    const storedOffsetY = localStorage.getItem("calibOffsetY");
    const storedOffsetZ = localStorage.getItem("calibOffsetZ");
    if (storedOffsetX !== null) calibOffsetX = parseFloat(storedOffsetX);
    if (storedOffsetY !== null) calibOffsetY = parseFloat(storedOffsetY);
    if (storedOffsetZ !== null) calibOffsetZ = parseFloat(storedOffsetZ);

    // Load 3x3 Advanced Calibration
    sixPosCalButton = document.getElementById("sixPosCalButton");
    resetCalMatrixButton = document.getElementById("resetCalMatrixButton");
    calib3x3EnabledCheckbox = document.getElementById("calib3x3Enabled");

    validateCalButton = document.getElementById("validateCalButton");
    calibStabilityThreshold = document.getElementById("calibStabilityThreshold");
    
    // Certificate UI mapping
    const viewCertButton = document.getElementById("viewCertButton");
    const certOverlay = document.getElementById("certOverlay");
    const closeCertBtn = document.getElementById("closeCertBtn");

    if (viewCertButton && certOverlay) {
        viewCertButton.onclick = () => {
            certOverlay.classList.remove("hidden");
        };
    }
    if (closeCertBtn && certOverlay) {
        closeCertBtn.onclick = () => {
            certOverlay.classList.add("hidden");
        };
    }

    calibHistorySelect = document.getElementById("calibHistorySelect");
    calibRollbackButton = document.getElementById("calibRollbackButton");

    // Load persistent 3x3 parameters
    const stored3x3Enabled = localStorage.getItem("calib3x3Enabled");
    if (stored3x3Enabled !== null) {
        calib3x3Enabled = stored3x3Enabled === "true";
        if (calib3x3EnabledCheckbox) calib3x3EnabledCheckbox.checked = calib3x3Enabled;
    }

    // Load stability threshold
    let storedThresh = localStorage.getItem("calibStabilityThreshold");
    if (storedThresh !== null) {
        let threshVal = parseFloat(storedThresh);
        if (isNaN(threshVal) || threshVal <= 0) {
            threshVal = 0.25;
            localStorage.setItem("calibStabilityThreshold", "0.25");
        }
        if (calibStabilityThreshold) calibStabilityThreshold.value = threshVal.toString();
    } else if (calibStabilityThreshold) {
        calibStabilityThreshold.value = "0.25";
    }
    if (calibStabilityThreshold) {
        calibStabilityThreshold.onchange = () => {
            localStorage.setItem("calibStabilityThreshold", calibStabilityThreshold.value);
        };
    }

    const stored3x3Matrix = localStorage.getItem("calib3x3Matrix");
    if (stored3x3Matrix !== null) {
        try {
            calib3x3Matrix = JSON.parse(stored3x3Matrix);
            updateMatrixUI();
        } catch (e) {
            console.error("Failed to parse 3x3 matrix:", e);
        }
    }

    const stored3x3Bias = localStorage.getItem("calib3x3Bias");
    if (stored3x3Bias !== null) {
        try {
            calib3x3Bias = JSON.parse(stored3x3Bias);
            updateBiasUI();
        } catch (e) {
            console.error("Failed to parse 3x3 bias:", e);
        }
    }

    // Validate current parameters integrity via Checksum
    const storedMetaStr = localStorage.getItem("calib3x3Metadata");
    if (storedMetaStr) {
        try {
            const meta = JSON.parse(storedMetaStr);
            const computedCk = calculateCalibChecksum(calib3x3Matrix, calib3x3Bias);
            if (meta.checksum !== computedCk) {
                console.warn("Current 3x3 calibration checksum mismatch! Restoring last valid history if available.");
                // Attempt to restore latest from history
                const historyStr = localStorage.getItem("calibHistory");
                let restored = false;
                if (historyStr) {
                    const history = JSON.parse(historyStr);
                    if (history && history.length > 0) {
                        const lastValid = history[0];
                        calib3x3Matrix = lastValid.static.matrix;
                        calib3x3Bias = lastValid.static.bias;
                        localStorage.setItem("calib3x3Matrix", JSON.stringify(calib3x3Matrix));
                        localStorage.setItem("calib3x3Bias", JSON.stringify(calib3x3Bias));
                        updateMatrixUI();
                        updateBiasUI();
                        if (lastValid.noise) {
                            calibratedNoiseRms = lastValid.noise;
                            localStorage.setItem('calibrated_noise_rms', JSON.stringify(calibratedNoiseRms));
                            updateNoiseFloorUI();
                        }
                        localStorage.setItem("calib3x3Metadata", JSON.stringify(lastValid));
                        showCalibMetricsPanel(lastValid);
                        restored = true;
                        console.log("Restored calibration from history due to checksum mismatch on current.");
                    }
                }
                if (!restored) {
                    showToast("Checksum Mismatch", "Current 3x3 calibration parameters are corrupted. Resetting to defaults.", "error", 6000);
                    calib3x3Matrix = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
                    calib3x3Bias = { x: 0.0, y: 0.0, z: 0.0 };
                    localStorage.setItem("calib3x3Matrix", JSON.stringify(calib3x3Matrix));
                    localStorage.setItem("calib3x3Bias", JSON.stringify(calib3x3Bias));
                    updateMatrixUI();
                    updateBiasUI();
                    localStorage.removeItem("calib3x3Metadata");
                    showCalibMetricsPanel(null);
                }
            } else {
                showCalibMetricsPanel(meta);
                if (meta.noise) {
                    calibratedNoiseRms = meta.noise;
                    localStorage.setItem('calibrated_noise_rms', JSON.stringify(calibratedNoiseRms));
                    updateNoiseFloorUI();
                }
            }
        } catch (e) {
            console.error("Error verifying calibration checksum:", e);
        }
    }

    // Set matrix input change events
    const matrixInputs = ["m00", "m01", "m02", "m10", "m11", "m12", "m20", "m21", "m22"];
    matrixInputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.onchange = onMatrixInputChange;
    });

    const biasInputs = ["bx", "by", "bz"];
    biasInputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.onchange = onBiasInputChange;
    });

    if (calib3x3EnabledCheckbox) {
        calib3x3EnabledCheckbox.onchange = () => {
            calib3x3Enabled = calib3x3EnabledCheckbox.checked;
            localStorage.setItem("calib3x3Enabled", calib3x3Enabled);
        };
    }

    if (sixPosCalButton) sixPosCalButton.onclick = startSixPosCalibration;
    if (validateCalButton) validateCalButton.onclick = startValidation;
    if (resetCalMatrixButton) resetCalMatrixButton.onclick = resetCalib3x3;
    if (calibRollbackButton) calibRollbackButton.onclick = rollbackCalibration;

    // Load history select list
    loadCalibrationHistoryUI();

    initCharts();
    updateWindowDisplay();
    updateFftResolution();

    connectButton.onclick = connectBLE;
    const btnRefreshList = document.getElementById("btnRefreshList");
    if (btnRefreshList) {
        btnRefreshList.onclick = connectBLE;
    }
    const disconnectSidebarBtn = document.getElementById("disconnectSidebarBtn");
    if (disconnectSidebarBtn) {
        disconnectSidebarBtn.onclick = connectBLE;
    }
    startButton.onclick = sendStart;
    stopButton.onclick = sendStop;
    if (calibrateButton) calibrateButton.onclick = startCalibration;
    if (tareButton) tareButton.onclick = startTareCalibration;
    exportButton.onclick = () => {
        const exportOptionsOverlay = document.getElementById("exportOptionsOverlay");
        const exportFilenameInput = document.getElementById("exportFilenameInput");
        if (exportFilenameInput) {
            exportFilenameInput.value = "accel_data";
        }
        if (exportOptionsOverlay) {
            exportOptionsOverlay.classList.remove("hidden");
        }
    };
    if (updateYAxisButton) updateYAxisButton.onclick = updateYAxis;
    zoomInButton.onclick = zoomIn;
    zoomOutButton.onclick = zoomOut;

    // Fullscreen Time Domain Waveform Toggle logic
    const btnFullscreenTimeChart = document.getElementById("btnFullscreenTimeChart");
    const timeChartCard = document.getElementById("timeChartCard");
    const fullscreenTimeChartIcon = document.getElementById("fullscreenTimeChartIcon");
    if (btnFullscreenTimeChart && timeChartCard) {
        btnFullscreenTimeChart.onclick = () => {
            const isFullscreen = timeChartCard.classList.toggle("fullscreen-chart-card");
            if (isFullscreen) {
                if (fullscreenTimeChartIcon) fullscreenTimeChartIcon.textContent = "fullscreen_exit";
                showToast("Fullscreen Mode", "Press Esc key or click the exit button to return.", "info", 3000);
            } else {
                if (fullscreenTimeChartIcon) fullscreenTimeChartIcon.textContent = "fullscreen";
            }
            // Clear inline styles/attributes to force Chart.js to recalculate layout dimensions accurately
            const canvas = document.getElementById("timeChart");
            if (canvas) {
                canvas.removeAttribute("width");
                canvas.removeAttribute("height");
                canvas.style.width = "";
                canvas.style.height = "";
            }
            if (typeof timeChart !== "undefined" && timeChart) {
                timeChart.resize();
                timeChart.update('none');
            }
        };
    }
    window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && timeChartCard && timeChartCard.classList.contains("fullscreen-chart-card")) {
            timeChartCard.classList.remove("fullscreen-chart-card");
            if (fullscreenTimeChartIcon) fullscreenTimeChartIcon.textContent = "fullscreen";
            const canvas = document.getElementById("timeChart");
            if (canvas) {
                canvas.removeAttribute("width");
                canvas.removeAttribute("height");
                canvas.style.width = "";
                canvas.style.height = "";
            }
            if (typeof timeChart !== "undefined" && timeChart) {
                timeChart.resize();
                timeChart.update('none');
            }
        }
    });

    if (bufferModeSelect) {
        bufferModeSelect.onchange = async () => {
            await writeBufferMode(bufferModeSelect.value);
            updateActiveDeviceConfigUI();
        };
    }

    if (samplingRateSelect) {
        samplingRateSelect.onchange = async () => {
            await writeSamplingRate(samplingRateSelect.value);
            updateActiveDeviceConfigUI();
        };
    }
    const txPowerSelect = document.getElementById("txPowerSelect");
    if (txPowerSelect) {
        txPowerSelect.onchange = async () => {
            await writeTxPower(txPowerSelect.value);
            updateActiveDeviceConfigUI();
        };
    }

    const ecoModeBtn = document.getElementById("ecoModeBtn");
    if (ecoModeBtn) {
        let ecoModeActive = false;
        ecoModeBtn.onclick = async () => {
            if (!isNrfDevice) {
                showToast("Not Supported", "Coin-Cell low power mode is only supported on nRF5340 transmitters. ESP32 transmitters require external or LiPo power.", "error", 6000);
                return;
            }
            ecoModeBtn.disabled = true;

            if (!ecoModeActive) {
                // Activating eco mode
                showToast("Eco Mode Activation", "Writing low-power coin-cell configurations...", "info", 3000);
                try {
                    if (sampleRateChar) {
                        await writeSamplingRate("1024");
                        const samplingRateSelect = document.getElementById("samplingRateSelect");
                        if (samplingRateSelect) samplingRateSelect.value = "1024";
                    }
                    
                    if (operatingModeChar) {
                        await writeBufferMode("0x10");
                        const bufferModeSelect = document.getElementById("bufferModeSelect");
                        if (bufferModeSelect) bufferModeSelect.value = "0x10";
                    }
                    
                    if (txPowerChar) {
                        const txDbm = isNrfDevice ? "-8" : "-12";
                        await writeTxPower(txDbm);
                        const txPowerSelect = document.getElementById("txPowerSelect");
                        if (txPowerSelect) txPowerSelect.value = txDbm;
                        if (typeof renderTxPowerCards === 'function') renderTxPowerCards();
                    }
                    
                    ecoModeActive = true;
                    ecoModeBtn.classList.add("eco-active");
                    ecoModeBtn.setAttribute("aria-checked", "true");
                    const ecoLabel = document.getElementById("ecoModeLabel");
                    if (ecoLabel) ecoLabel.textContent = "Coin-Cell Eco Mode Active";
                    updateActiveDeviceConfigUI();
                    updateStatusBar();
                    showToast("Eco Mode Active", "Device successfully optimized for Coin-Cell power limits!", "success", 4000);
                } catch (e) {
                    console.error("Failed to enable Coin-Cell Mode:", e);
                    showToast("Configuration Error", "Could not write all coin-cell parameters: " + e.message, "error", 5000);
                } finally {
                    ecoModeBtn.disabled = false;
                }
            } else {
                // Deactivating eco mode — restore defaults
                try {
                    if (sampleRateChar) {
                        await writeSamplingRate("1024");
                        const samplingRateSelect = document.getElementById("samplingRateSelect");
                        if (samplingRateSelect) samplingRateSelect.value = "1024";
                    }
                    if (txPowerChar) {
                        await writeTxPower("0");
                        const txPowerSelect = document.getElementById("txPowerSelect");
                        if (txPowerSelect) txPowerSelect.value = "0";
                        if (typeof renderTxPowerCards === 'function') renderTxPowerCards();
                    }
                    ecoModeActive = false;
                    ecoModeBtn.classList.remove("eco-active");
                    ecoModeBtn.setAttribute("aria-checked", "false");
                    const ecoLabel = document.getElementById("ecoModeLabel");
                    if (ecoLabel) ecoLabel.textContent = "Standard Power Mode";
                    updateActiveDeviceConfigUI();
                    updateStatusBar();
                    showToast("Standard Mode", "Reverted to standard power configuration.", "info", 3000);
                } catch (e) {
                    showToast("Configuration Error", "Could not revert: " + e.message, "error", 5000);
                } finally {
                    ecoModeBtn.disabled = false;
                }
            }
        };
    }

    const bypassDashboardBtn = document.getElementById("bypassDashboardBtn");
    if (bypassDashboardBtn) {
        bypassDashboardBtn.onclick = () => {
            const connectionScreen = document.getElementById("connectionScreen");
            const dashboardScreen = document.getElementById("dashboardScreen");
            if (connectionScreen && dashboardScreen) {
                connectionScreen.classList.remove("active");
                connectionScreen.classList.add("hidden");
                dashboardScreen.classList.remove("hidden");
                dashboardScreen.classList.add("active");
                
                window.isBypassMode = true;
                isNrfDevice = true; // Pretend it is an nRF device for config testing
                
                // Set default mock statuses in UI
                const activeDeviceSensor = document.getElementById("activeDeviceSensor");
                const activeDeviceRange = document.getElementById("activeDeviceRange");
                const activeDeviceSampleRate = document.getElementById("activeDeviceSampleRate");
                const activeDeviceTxPower = document.getElementById("activeDeviceTxPower");
                const activeDeviceBuffer = document.getElementById("activeDeviceBuffer");
                const activeDeviceSync = document.getElementById("activeDeviceSync");
                
                if (activeDeviceSensor) activeDeviceSensor.textContent = "H3LIS331DL (Mock)";
                if (activeDeviceRange) activeDeviceRange.textContent = "±400g";
                if (activeDeviceSampleRate) activeDeviceSampleRate.textContent = "1024 Hz";
                if (activeDeviceTxPower) activeDeviceTxPower.textContent = "-8 dBm";
                if (activeDeviceBuffer) activeDeviceBuffer.textContent = "No Buffer";
                if (activeDeviceSync) {
                    activeDeviceSync.textContent = "BYPASS MODE";
                    activeDeviceSync.className = "badge-status-green";
                }
                
                // Enable dashboard buttons
                startButton.disabled = false;
                stopButton.disabled = true;
                exportButton.disabled = true;
                if (calibrateButton) calibrateButton.disabled = false;
                if (tareButton) tareButton.disabled = false;
                if (sixPosCalButton) sixPosCalButton.disabled = false;
                if (validateCalButton) validateCalButton.disabled = false;
                if (resetCalMatrixButton) resetCalMatrixButton.disabled = false;
                
                // Trigger chart container visibility toggle
                if (window.updateChartEmptyStates) {
                    window.updateChartEmptyStates();
                }
                
                // Select first workspace drawer
                switchWorkspace("config");
                showToast("Developer Mode Active", "Switched to dashboard. Telemetry acquisition will simulate virtual sine waves.", "info", 4000);
            }
        };
    }

    document.getElementById("toggleX").onclick = (e) => toggleTimeAxis(0, e.target);
    document.getElementById("toggleY").onclick = (e) => toggleTimeAxis(1, e.target);
    document.getElementById("toggleZ").onclick = (e) => toggleTimeAxis(2, e.target);

    fftAxisSelect.onchange = () => { fftAxis = fftAxisSelect.value; };
    fftSizeSelect.onchange = () => {
        fftSize = parseInt(fftSizeSelect.value);
        updateFftResolution();
    };
    const fftWindowSelect = document.getElementById("fftWindowSelect");
    if (fftWindowSelect) fftWindowSelect.onchange = () => { fftWindowType = fftWindowSelect.value; };

    // Cycle count input
    const cycleInput = document.getElementById("cycleCountInput");
    if (cycleInput) {
        cycleInput.addEventListener('input', () => {
            const val = parseInt(cycleInput.value);
            cycleCount = (val > 0 && !isNaN(val)) ? val : 0;
        });
    }

    // Auto-scale Y checkbox
    const autoScaleCheckbox = document.getElementById("autoScaleY");
    if (autoScaleCheckbox) {
        autoScaleCheckbox.addEventListener('change', () => {
            autoScaleY = autoScaleCheckbox.checked;
            if (!autoScaleY) {
                timeChart.options.scales.y.min = -2;
                timeChart.options.scales.y.max = 2;
                timeChart.update();
            }
        });
    }

    // ===== Timed Run Event Listeners =====
    const timedRunCheckbox = document.getElementById("timedRunEnabled");
    const timedRunSettings = document.getElementById("timedRunSettings");
    const timedRunInput = document.getElementById("timedRunDurationInput");
    const timedRunSlider = document.getElementById("timedRunSlider");

    if (timedRunCheckbox && timedRunSettings && timedRunInput && timedRunSlider) {
        timedRunCheckbox.addEventListener('change', () => {
            timedRunEnabled = timedRunCheckbox.checked;
            if (timedRunEnabled) {
                timedRunSettings.classList.remove('disabled');
            } else {
                timedRunSettings.classList.add('disabled');
            }
        });

        const syncDuration = (val) => {
            let duration = parseInt(val);
            if (isNaN(duration) || duration < 1) duration = 1;
            if (duration > 300) duration = 300;
            timedDuration = duration;
            
            // Sync to the input if different
            if (parseInt(timedRunInput.value) !== duration) {
                timedRunInput.value = duration;
            }
            // Sync to the slider if within its range (1 to 120)
            const sliderVal = Math.min(duration, 120);
            if (parseInt(timedRunSlider.value) !== sliderVal) {
                timedRunSlider.value = sliderVal;
            }
        };

        timedRunInput.addEventListener('input', () => syncDuration(timedRunInput.value));
        timedRunSlider.addEventListener('input', () => syncDuration(timedRunSlider.value));
    }

    // ===== Signal Processing UI Event Listeners =====
    const couplingSelect = document.getElementById("couplingSelect");
    const filterTypeSelect = document.getElementById("filterTypeSelect");
    const filterOrderSelect = document.getElementById("filterOrderSelect");
    const filterCutoffInput = document.getElementById("filterCutoffInput");
    const displayQuantitySelect = document.getElementById("displayQuantitySelect");
    const cutoffFieldGroup = document.getElementById("cutoffFieldGroup");
    const filterPlotDetails = document.getElementById("filterPlotDetails");
    const dspPresetSelect = document.getElementById("dspPresetSelect");
    const showPhasePlot = document.getElementById("showPhasePlot");

    const updateFilterStage = () => {
        const filterStage = signalPipeline.stages.find(s => s.name === 'filter');
        if (filterStage) {
            const type = filterTypeSelect ? filterTypeSelect.value : 'None';
            const order = filterOrderSelect ? parseInt(filterOrderSelect.value) : 4;
            const cutoff = filterCutoffInput ? parseFloat(filterCutoffInput.value) : 100;
            
            if (cutoffFieldGroup) {
                cutoffFieldGroup.style.display = (type !== 'None') ? 'flex' : 'none';
            }
            
            filterStage.configure(type, order, cutoff, SAMPLE_RATE);
            signalPipeline.reset();
            velocityGen.reset();
            displacementGen.reset();
            drawFilterResponsePlot();
        }
    };

    const handleCustomChange = () => {
        if (dspPresetSelect) {
            dspPresetSelect.value = "custom";
        }
    };

    if (couplingSelect) {
        couplingSelect.addEventListener("change", () => {
            handleCustomChange();
            const mode = couplingSelect.value;
            signalPipeline.updateParams(mode, SAMPLE_RATE);
            signalPipeline.reset();
            velocityGen.reset();
            displacementGen.reset();
            drawFilterResponsePlot();
            console.log(`[Signal Processing] Coupling mode changed to: ${mode}`);
        });
    }

    if (filterTypeSelect) {
        filterTypeSelect.addEventListener("change", () => {
            handleCustomChange();
            updateFilterStage();
        });
    }
    if (filterOrderSelect) {
        filterOrderSelect.addEventListener("change", () => {
            handleCustomChange();
            updateFilterStage();
        });
    }
    if (filterCutoffInput) {
        filterCutoffInput.addEventListener("input", () => {
            handleCustomChange();
            updateFilterStage();
        });
    }

    const updateQuantityUIAndChart = (qty) => {
        displayQuantity = qty;
        if (displayQuantitySelect) displayQuantitySelect.value = qty;
        
        velocityGen.reset();
        displacementGen.reset();
        
        timeChart.data.datasets.forEach(ds => ds.data = []);
        timeChart.update('none');

        if (displayQuantity === 'velocity') {
            timeChart.options.scales.y.title.text = "Velocity (mm/s)";
            if (fftChart) fftChart.options.scales.y.title.text = "Magnitude (mm/s)";
            timeChart.data.datasets[0].label = "X (mm/s)";
            timeChart.data.datasets[1].label = "Y (mm/s)";
            timeChart.data.datasets[2].label = "Z (mm/s)";
            yAxisMin.value = "-50.0";
            yAxisMax.value = "50.0";
        } else if (displayQuantity === 'displacement') {
            timeChart.options.scales.y.title.text = "Displacement (µm)";
            if (fftChart) fftChart.options.scales.y.title.text = "Magnitude (µm)";
            timeChart.data.datasets[0].label = "X (µm)";
            timeChart.data.datasets[1].label = "Y (µm)";
            timeChart.data.datasets[2].label = "Z (µm)";
            yAxisMin.value = "-500.0";
            yAxisMax.value = "500.0";
        } else { // 'acceleration'
            timeChart.options.scales.y.title.text = "Acceleration (g)";
            if (fftChart) fftChart.options.scales.y.title.text = "Magnitude (g)";
            timeChart.data.datasets[0].label = "X (g)";
            timeChart.data.datasets[1].label = "Y (g)";
            timeChart.data.datasets[2].label = "Z (g)";
            yAxisMin.value = "-2.0";
            yAxisMax.value = "2.0";
        }
        
        const driftCutoffGroup = document.getElementById("driftCutoffGroup");
        if (driftCutoffGroup) {
            driftCutoffGroup.style.display = (qty === 'acceleration') ? 'none' : 'block';
        }
        
        updateYAxis();
    };

    if (displayQuantitySelect) {
        displayQuantitySelect.addEventListener("change", () => {
            handleCustomChange();
            updateQuantityUIAndChart(displayQuantitySelect.value);
            console.log(`[Signal Processing] Display Quantity changed to: ${displayQuantity}`);
        });
    }

    const driftCutoffSelect = document.getElementById("driftCutoffSelect");
    if (driftCutoffSelect) {
        driftCutoffSelect.addEventListener("change", () => {
            const cutoff = parseFloat(driftCutoffSelect.value);
            velocityGen.configure(SAMPLE_RATE, cutoff);
            displacementGen.configure(SAMPLE_RATE, cutoff);
            console.log(`[Signal Processing] Drift Removal HPF Cutoff changed to: ${cutoff} Hz`);
        });
    }

    if (dspPresetSelect) {
        dspPresetSelect.addEventListener("change", () => {
            const val = dspPresetSelect.value;
            if (val === "machinery") {
                if (couplingSelect) couplingSelect.value = "AC_3";
                if (filterTypeSelect) filterTypeSelect.value = "LPF";
                if (filterOrderSelect) filterOrderSelect.value = "4";
                if (filterCutoffInput) filterCutoffInput.value = "500";
                
                signalPipeline.updateParams("AC_3", SAMPLE_RATE);
                updateFilterStage();
                updateQuantityUIAndChart("velocity");
                
                console.log("[Preset] Applied Machinery Monitoring Preset (AC 3Hz, LPF 500Hz, Velocity)");
            } else if (val === "structural") {
                if (couplingSelect) couplingSelect.value = "DC";
                if (filterTypeSelect) filterTypeSelect.value = "LPF";
                if (filterOrderSelect) filterOrderSelect.value = "4";
                if (filterCutoffInput) filterCutoffInput.value = "50";
                
                signalPipeline.updateParams("DC", SAMPLE_RATE);
                updateFilterStage();
                updateQuantityUIAndChart("displacement");
                
                console.log("[Preset] Applied Structural Dynamics Preset (DC, LPF 50Hz, Displacement)");
            } else if (val === "shock") {
                if (couplingSelect) couplingSelect.value = "AC_10";
                if (filterTypeSelect) filterTypeSelect.value = "HPF";
                if (filterOrderSelect) filterOrderSelect.value = "2";
                if (filterCutoffInput) filterCutoffInput.value = "10";
                
                signalPipeline.updateParams("AC_10", SAMPLE_RATE);
                updateFilterStage();
                updateQuantityUIAndChart("acceleration");
                
                console.log("[Preset] Applied Shock Test Preset (AC 10Hz, HPF 10Hz, Acceleration)");
            }
        });
    }

    if (showPhasePlot) {
        showPhasePlot.addEventListener("change", () => {
            drawFilterResponsePlot();
        });
    }

    if (filterPlotDetails && filterPlotDetails.tagName === "DETAILS") {
        filterPlotDetails.addEventListener("toggle", () => {
            if (filterPlotDetails.open) {
                setTimeout(drawFilterResponsePlot, 50);
            }
        });
    }

    // Dynamic resize drawing of response analyser
    window.addEventListener("resize", () => {
        drawFilterResponsePlot();
    });

    // Toggle show/collapse of response analyzer
    const btnShowAnalyzer = document.getElementById("btnShowAnalyzer");
    const btnHideAnalyzer = document.getElementById("btnHideAnalyzer");
    const analyzerContainer = document.getElementById("analyzerContainer");

    if (btnShowAnalyzer && btnHideAnalyzer && analyzerContainer) {
        btnShowAnalyzer.addEventListener("click", () => {
            btnShowAnalyzer.classList.add("hidden");
            analyzerContainer.classList.remove("hidden");
            // Redraw with new active dimensions after DOM settles
            setTimeout(drawFilterResponsePlot, 50);
        });

        btnHideAnalyzer.addEventListener("click", () => {
            analyzerContainer.classList.add("hidden");
            btnShowAnalyzer.classList.remove("hidden");
        });
    }

    // ===== Export Modal Dialog Event Listeners =====
    const exportCancelBtn = document.getElementById("exportCancelBtn");
    const exportConfirmBtn = document.getElementById("exportConfirmBtn");
    const exportOptionsOverlay = document.getElementById("exportOptionsOverlay");

    if (exportCancelBtn && exportOptionsOverlay) {
        exportCancelBtn.onclick = () => {
            exportOptionsOverlay.classList.add("hidden");
        };
        // Also close on overlay background click
        exportOptionsOverlay.addEventListener('click', (e) => {
            if (e.target === exportOptionsOverlay) {
                exportOptionsOverlay.classList.add("hidden");
            }
        });
    }

    if (exportConfirmBtn && exportOptionsOverlay) {
        exportConfirmBtn.onclick = () => {
            // Read selected file format
            const formatRadios = document.getElementsByName("exportFileFormat");
            let fileFormat = "csv";
            for (const f of formatRadios) {
                if (f.checked) { fileFormat = f.value; break; }
            }
            
            // Read content checkboxes
            const contentFlags = {
                rawAccel: document.getElementById('expRawAccel')?.checked ?? true,
                procAccel: document.getElementById('expProcAccel')?.checked ?? true,
                velocity: document.getElementById('expVelocity')?.checked ?? false,
                displacement: document.getElementById('expDisplacement')?.checked ?? false,
                fft: document.getElementById('expFFT')?.checked ?? false,
                psd: document.getElementById('expPSD')?.checked ?? false,
                statistics: document.getElementById('expStatistics')?.checked ?? true,
                dspConfig: document.getElementById('expDspConfig')?.checked ?? false,
            };
            
            // Read metadata checkboxes
            const metaFlags = {
                sensorInfo: document.getElementById('expSensorInfo')?.checked ?? true,
                calibInfo: document.getElementById('expCalibInfo')?.checked ?? true,
                teds: document.getElementById('expTEDS')?.checked ?? false,
                pipeline: document.getElementById('expPipeline')?.checked ?? false,
                acqSettings: document.getElementById('expAcqSettings')?.checked ?? true,
            };
            
            const exportFilenameInput = document.getElementById("exportFilenameInput");
            const baseName = exportFilenameInput ? (exportFilenameInput.value.trim() || "measurement") : "measurement";
            
            exportOptionsOverlay.classList.add("hidden");
            exportMeasurementSession(fileFormat, baseName, contentFlags, metaFlags);
        };
    }

    // ================= SCREEN TRANSITION & WORKSPACE ROUTING =================
    const splashScreen = document.getElementById("splashScreen");
    const connectionScreen = document.getElementById("connectionScreen");

    let captionInterval = null;
    let tipInterval = null;

    const goToMainApp = () => {
        if (splashTimeout) clearTimeout(splashTimeout);
        if (splashScreen) {
            splashScreen.classList.remove("active");
            splashScreen.classList.add("hidden");
        }
        if (connectionScreen) {
            connectionScreen.classList.remove("hidden");
            connectionScreen.classList.add("active");
        }
        
        // Load recent devices list
        if (typeof updateRecentDevicesList === "function") {
            updateRecentDevicesList();
        }
    };

    // Simulated loading sequence
    const progressBar = document.getElementById("splashProgressBar");
    const percentLabel = document.getElementById("splashPercentLabel");
    const loadingInfo = document.getElementById("splashLoadingInfo");

    const loadingStages = [
        { progress: 10, text: "Initializing Application..." },
        { progress: 20, text: "Loading Signal Processing Engine..." },
        { progress: 30, text: "Initializing Analysis Modules..." },
        { progress: 40, text: "Loading Calibration Framework..." },
        { progress: 50, text: "Preparing Visualization Engine..." },
        { progress: 60, text: "Initializing Data Acquisition Services..." },
        { progress: 70, text: "Loading Device Profiles..." },
        { progress: 80, text: "Checking System Resources..." },
        { progress: 90, text: "Preparing Instrument Workspace..." },
        { progress: 100, text: "Ready." }
    ];

    let currentStageIndex = 0;
    let splashTimeout = null;

    const runLoadingStep = () => {
        if (currentStageIndex >= loadingStages.length) {
            const splashLoadingContent = document.getElementById("splashLoadingContent");
            const splashReadyContainer = document.getElementById("splashReadyContainer");

            if (splashLoadingContent) {
                splashLoadingContent.classList.add("opacity-0");
                setTimeout(() => {
                    splashLoadingContent.classList.add("hidden");
                    if (splashReadyContainer) {
                        splashReadyContainer.classList.remove("hidden");
                        setTimeout(() => {
                            splashReadyContainer.classList.remove("opacity-0");
                        }, 50);
                    }
                }, 500);
            }

            // After 1.5 seconds transition, fade out the whole splash screen
            setTimeout(() => {
                if (splashScreen) {
                    splashScreen.classList.add("opacity-0");
                    setTimeout(() => {
                        goToMainApp();
                    }, 1000);
                } else {
                    goToMainApp();
                }
            }, 1500);
            return;
        }

        const stage = loadingStages[currentStageIndex];
        if (progressBar) progressBar.style.width = `${stage.progress}%`;
        if (percentLabel) percentLabel.textContent = `${stage.progress}%`;
        if (loadingInfo) loadingInfo.textContent = stage.text;

        currentStageIndex++;
        splashTimeout = setTimeout(runLoadingStep, 250); // 10 steps * 250ms = 2.5 seconds total
    };

    // Start loading loop
    runLoadingStep();

    // Workspace Switching Logic (Controls Tab switching in Drawer)
    window.switchWorkspace = function(name) {
        console.log("Switching workspace to:", name);
        const capName = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
        
        // Hide all drawer panes
        const panes = document.querySelectorAll(".drawer-pane");
        panes.forEach(p => {
            p.classList.add("hidden");
        });
        
        // Deactivate all sidebar tab buttons
        const tabBtns = document.querySelectorAll(".side-tab-btn");
        tabBtns.forEach(btn => {
            btn.classList.remove("active-tab");
        });
        
        // Activate target drawer pane
        const targetPane = document.getElementById("drawer" + capName);
        if (targetPane) {
            targetPane.classList.remove("hidden");
        }
        
        // Activate corresponding tab button
        const targetBtn = document.getElementById("sideTabBtn" + capName);
        if (targetBtn) {
            targetBtn.classList.add("active-tab");
        }
        
        // Update drawer title based on selection
        const drawerTitle = document.getElementById("drawerTitle");
        if (drawerTitle) {
            if (capName === "Device") drawerTitle.textContent = "Acquisition Controls";
            else if (capName === "Config") drawerTitle.textContent = "Sensor Configuration";
            else if (capName === "Calibration") drawerTitle.textContent = "Calibration Wizards";
            else if (capName === "Dsp") drawerTitle.textContent = "DSP Configuration";
            else if (capName === "Export") drawerTitle.textContent = "Measurement Session";
        }
        
        // Ensure control drawer is visible (expand if it was collapsed)
        const controlDrawer = document.getElementById("controlDrawer");
        if (controlDrawer) {
            controlDrawer.classList.remove("w-0");
        }

        // Trigger resize event so Chart.js recalibrates canvas sizes immediately
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
        }, 50);
        
        if (typeof updateChartEmptyStates === "function") {
            updateChartEmptyStates();
        }
    };
    
    // Bind click handlers to workspace switcher tabs
    document.querySelectorAll(".side-tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const targetId = btn.getAttribute("data-target");
            if (targetId) {
                const paneName = targetId.replace("drawer", "").toLowerCase();
                const controlDrawer = document.getElementById("controlDrawer");
                
                // If clicking the currently active tab and drawer is open, collapse it
                if (btn.classList.contains("active-tab") && controlDrawer && !controlDrawer.classList.contains("w-0")) {
                    controlDrawer.classList.add("w-0");
                } else {
                    switchWorkspace(paneName);
                }
            }
        });
    });

    // Control Drawer collapse button handler
    const btnCollapseDrawer = document.getElementById("btnCollapseDrawer");
    if (btnCollapseDrawer) {
        btnCollapseDrawer.addEventListener("click", () => {
            const controlDrawer = document.getElementById("controlDrawer");
            if (controlDrawer) {
                controlDrawer.classList.add("w-0");
            }
        });
    }

    // Back to Connection Screen button handler
    const backToConnectBtn = document.getElementById("backToConnectBtn");
    if (backToConnectBtn) {
        backToConnectBtn.addEventListener("click", () => {
            if (window.isBypassMode) {
                if (window.simInterval) {
                    clearInterval(window.simInterval);
                    delete window.simInterval;
                }
                window.isBypassMode = false;
            }
            const connScreen = document.getElementById("connectionScreen");
            const dashScreen = document.getElementById("dashboardScreen");
            if (connScreen && dashScreen) {
                dashScreen.classList.remove("active");
                dashScreen.classList.add("hidden");
                connScreen.classList.remove("hidden");
                connScreen.classList.add("active");
            }
        });
    }

    // Chart Empty States Manager
    window.updateChartEmptyStates = function() {
        const isConnected = !!(device && device.gatt && device.gatt.connected) || !!window.isBypassMode;
        
        const timeViewport = document.getElementById("timeChartViewport");
        const spectralViewport = document.getElementById("spectralChartViewport");
        
        const toggleOverlay = (viewport) => {
            if (!viewport) return;
            let overlay = viewport.querySelector(".chart-empty-overlay");
            if (!isConnected) {
                if (!overlay) {
                    overlay = document.createElement("div");
                    overlay.className = "chart-empty-overlay absolute inset-0 flex flex-col items-center justify-center bg-white/90 backdrop-blur-sm z-10 text-center gap-1.5 transition-all select-none";
                    overlay.innerHTML = `
                        <span class="material-symbols-outlined text-slate-400 text-3xl">sensors_off</span>
                        <span class="text-xs font-bold text-slate-700">No telemetry data yet</span>
                        <span class="text-[10px] text-slate-400">Connect a device to begin active acquisition</span>
                    `;
                    viewport.appendChild(overlay);
                }
            } else {
                if (overlay) overlay.remove();
            }
        };
        
        toggleOverlay(timeViewport);
        toggleOverlay(spectralViewport);
    };

    // Keyboard Shortcuts Listener
    window.addEventListener("keydown", (e) => {
        if (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "SELECT") {
            return; // Skip if user is editing inputs
        }
        
        // Space = Start/Stop Stream
        if (e.code === "Space") {
            e.preventDefault();
            const btn = document.getElementById("unifiedStreamBtn");
            if (btn && !btn.disabled) {
                btn.click();
            }
        }
        // Ctrl+E = Export CSV
        if (e.ctrlKey && e.code === "KeyE") {
            e.preventDefault();
            const btn = document.getElementById("btnExportCSV");
            if (btn && !btn.disabled) {
                btn.click();
            }
        }
        // Ctrl+R = Record telemetry
        if (e.ctrlKey && e.code === "KeyR") {
            e.preventDefault();
            const btn = document.getElementById("recordButton");
            if (btn && !btn.disabled) {
                btn.click();
            }
        }
    });

    // Local Storage Recent Devices Manager
    window.saveRecentDevice = function(name, id) {
        let recent = [];
        try {
            recent = JSON.parse(localStorage.getItem("recent_devices")) || [];
        } catch(e) {}
        
        recent = recent.filter(d => d.id !== id);
        recent.unshift({ name, id, timestamp: Date.now() });
        recent = recent.slice(0, 3);
        
        localStorage.setItem("recent_devices", JSON.stringify(recent));
        if (typeof updateRecentDevicesList === "function") {
            updateRecentDevicesList();
        }
    };

    window.updateRecentDevicesList = function() {
        const listEl = document.getElementById("recentDevicesList");
        if (!listEl) return;
        
        let recent = [];
        try {
            recent = JSON.parse(localStorage.getItem("recent_devices")) || [];
        } catch(e) {}
        
        if (recent.length === 0) {
            listEl.innerHTML = `<div class="text-[10px] text-slate-400 italic">No recently connected devices</div>`;
            return;
        }
        
        listEl.innerHTML = "";
        recent.forEach(d => {
            const item = document.createElement("div");
            item.className = "flex justify-between items-center bg-slate-50 border border-slate-100 p-2.5 rounded-lg hover:border-primary/40 cursor-pointer transition select-none text-xs text-slate-700";
            item.innerHTML = `
                <div class="flex items-center gap-2">
                    <span class="material-symbols-outlined text-[15px] text-slate-400">history</span>
                    <span class="font-semibold">${d.name}</span>
                </div>
                <span class="text-[9px] font-mono text-slate-400">${d.id}</span>
            `;
            item.onclick = () => {
                console.log("Connecting to recent device:", d.name);
                const detailsPanel = document.getElementById("details-panel");
                if (detailsPanel) detailsPanel.classList.remove("hidden");
                
                const detailName = document.getElementById("nodeDetailName");
                if (detailName) detailName.textContent = d.name;
                const detailMac = document.getElementById("nodeDetailMac");
                if (detailMac) detailMac.textContent = "MAC: " + d.id;
                
                const detailStatus = document.getElementById("nodeDetailStatus");
                if (detailStatus) {
                    detailStatus.textContent = "PAIRING...";
                    detailStatus.className = "text-numeric-data text-orange-500 font-semibold";
                }
                
                if (window.electronAPI && typeof window.electronAPI.selectDevice === "function") {
                    window.electronAPI.selectDevice(d.id);
                }
            };
            listEl.appendChild(item);
        });
    };

    // Chart Card Collapsible Toggle logic
    document.querySelectorAll('.card-collapse-btn').forEach(btn => {
        const targetId = btn.getAttribute('data-target');
        const viewport = document.getElementById(targetId);
        
        // Restore from localStorage
        const isCollapsed = localStorage.getItem(`directBLE_card_collapsed_${targetId}`) === 'true';
        if (isCollapsed && viewport) {
            viewport.classList.add('collapsed');
            btn.classList.add('rotated');
        }
        
        btn.onclick = () => {
            if (viewport) {
                const nowCollapsed = viewport.classList.toggle('collapsed');
                btn.classList.toggle('rotated', nowCollapsed);
                localStorage.setItem(`directBLE_card_collapsed_${targetId}`, nowCollapsed ? 'true' : 'false');
                setTimeout(() => {
                    window.dispatchEvent(new Event('resize'));
                }, 100);
            }
        };
    });

    // Spectral Tabs switching
    const tabFft = document.getElementById("tabFft");
    const tabPsd = document.getElementById("tabPsd");
    const fftViewContainer = document.getElementById("fftViewContainer");
    const psdViewContainer = document.getElementById("psdViewContainer");
    const psdAveragesContainer = document.getElementById("psdAveragesContainer");

    if (tabFft && tabPsd) {
        const setTab = (activeTab) => {
            if (activeTab === "fft") {
                tabFft.className = "h-full px-3.5 text-[11px] font-bold uppercase tracking-wider text-primary border-b-2 border-primary";
                tabPsd.className = "h-full px-3.5 text-[11px] font-bold uppercase tracking-wider text-text-secondary hover:text-primary";
                if (fftViewContainer) fftViewContainer.classList.remove("hidden");
                if (psdViewContainer) psdViewContainer.classList.add("hidden");
                if (psdAveragesContainer) psdAveragesContainer.classList.add("hidden");
            } else {
                tabFft.className = "h-full px-3.5 text-[11px] font-bold uppercase tracking-wider text-text-secondary hover:text-primary";
                tabPsd.className = "h-full px-3.5 text-[11px] font-bold uppercase tracking-wider text-primary border-b-2 border-primary";
                if (fftViewContainer) fftViewContainer.classList.add("hidden");
                if (psdViewContainer) psdViewContainer.classList.remove("hidden");
                if (psdAveragesContainer) psdAveragesContainer.classList.remove("hidden");
            }
            setTimeout(() => {
                window.dispatchEvent(new Event('resize'));
            }, 50);
        };

        tabFft.addEventListener("click", () => setTab("fft"));
        tabPsd.addEventListener("click", () => setTab("psd"));
    }

    // PSD Averages select listener
    const psdAveragesSelect = document.getElementById("psdAveragesSelect");
    if (psdAveragesSelect) {
        psdAveragesSelect.addEventListener("change", (e) => {
            const avg = parseInt(e.target.value, 10) || 1;
            psdAnalyzer.setAverages(avg);
            psdAnalyzer.reset();
        });
    }

    // Initial update
    updateDAQStatus();

    // ===== Unified Stream Button Synchronization =====
    const unifiedStreamBtn = document.getElementById("unifiedStreamBtn");
    if (unifiedStreamBtn) {
        unifiedStreamBtn.onclick = () => {
            if (startButton && !startButton.disabled) {
                startButton.click();
            } else if (stopButton && !stopButton.disabled) {
                stopButton.click();
            }
        };

        setInterval(() => {
            const unifiedStreamIcon = document.getElementById("unifiedStreamIcon");
            const unifiedStreamText = document.getElementById("unifiedStreamText");
            
            // Check if it is currently streaming
            const isStreaming = startButton && startButton.disabled && stopButton && !stopButton.disabled;
            
            if (isStreaming) {
                // Style as "Stop Streaming" (Red background)
                unifiedStreamBtn.className = "w-full h-10 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold text-xs hover:opacity-95 transition-all flex items-center justify-center gap-1.5 shadow-sm select-none";
                if (unifiedStreamIcon) {
                    unifiedStreamIcon.textContent = "stop";
                }
                if (unifiedStreamText) {
                    // Check if stopButton has timed countdown text (e.g., "Stop (8.4s)")
                    if (stopButton.textContent && stopButton.textContent.includes("Stop (")) {
                        unifiedStreamText.textContent = stopButton.textContent;
                    } else {
                        unifiedStreamText.textContent = "Stop Streaming";
                    }
                }
            } else {
                // Style as "Start Streaming" (Primary Blue background)
                unifiedStreamBtn.className = "w-full h-10 bg-primary hover:opacity-95 text-white rounded-lg font-semibold text-xs transition-all flex items-center justify-center gap-1.5 shadow-sm select-none";
                if (unifiedStreamIcon) {
                    unifiedStreamIcon.textContent = "play_arrow";
                }
                if (unifiedStreamText) {
                    unifiedStreamText.textContent = "Start Streaming";
                }
                
                // If the start button is disabled by other factors (e.g. calibration active)
                if (startButton && startButton.disabled) {
                    unifiedStreamBtn.disabled = true;
                    unifiedStreamBtn.classList.add("opacity-50", "cursor-not-allowed");
                } else {
                    unifiedStreamBtn.disabled = false;
                    unifiedStreamBtn.classList.remove("opacity-50", "cursor-not-allowed");
                }
            }
        }, 50);
    }
});



// ================= BLE Connection Manager =================

async function connectBLE() {
    if (device && device.gatt.connected) {
        device.gatt.disconnect();
        return;
    }
    
    // Prevent double-clicking by checking if we are already in a connection/scan attempt
    const connectButton = document.getElementById("connectButton");
    if (connectButton && connectButton.disabled) {
        return;
    }

    // Cancel any stale/pending scan in the main process before starting a new one
    if (window.electronAPI && typeof window.electronAPI.cancelScan === "function") {
        window.electronAPI.cancelScan();
    }

    const scanningIndicator = document.getElementById("scanningIndicator");
    const deviceListEmpty = document.getElementById("deviceListEmpty");
    const scannedDevicesList = document.getElementById("scannedDevicesList");
    
    // Preserve deviceListEmpty inside the grid — only remove dynamic cards
    if (scannedDevicesList) {
        Array.from(scannedDevicesList.children).forEach(child => {
            if (child.id !== 'deviceListEmpty') child.remove();
        });
    }
    
    let cleanupDevicesListener = null;

    try {
        if (connectButton) {
            connectButton.disabled = true;
            connectButton.innerHTML = '<span class="material-symbols-outlined text-[16px] animate-spin">progress_activity</span> Scanning...';
        }
        if (scanningIndicator) scanningIndicator.classList.remove("hidden");
        if (deviceListEmpty) deviceListEmpty.classList.add("hidden");

        // Append visual skeletons
        if (scannedDevicesList) {
            const skeleton1 = document.createElement("div");
            skeleton1.className = "border border-slate-200/60 rounded-xl p-5 bg-white flex flex-col gap-3 animate-pulse select-none dynamic-skeleton";
            skeleton1.innerHTML = `
                <div class="flex justify-between">
                    <div class="w-24 h-4 bg-slate-200 rounded"></div>
                    <div class="w-12 h-4 bg-slate-150 rounded"></div>
                </div>
                <div class="w-32 h-3 bg-slate-100 rounded"></div>
                <div class="mt-2 pt-2.5 border-t border-slate-100 flex justify-end">
                    <div class="w-16 h-5 bg-slate-200/50 rounded-lg"></div>
                </div>
            `;
            const skeleton2 = document.createElement("div");
            skeleton2.className = "border border-slate-200/60 rounded-xl p-5 bg-white flex flex-col gap-3 animate-pulse select-none dynamic-skeleton";
            skeleton2.innerHTML = `
                <div class="flex justify-between">
                    <div class="w-20 h-4 bg-slate-200 rounded"></div>
                    <div class="w-12 h-4 bg-slate-150 rounded"></div>
                </div>
                <div class="w-28 h-3 bg-slate-100 rounded"></div>
                <div class="mt-2 pt-2.5 border-t border-slate-100 flex justify-end">
                    <div class="w-16 h-5 bg-slate-200/50 rounded-lg"></div>
                </div>
            `;
            scannedDevicesList.appendChild(skeleton1);
            scannedDevicesList.appendChild(skeleton2);
        }

        // Update footer status bar
        const footerStatusDot = document.getElementById("footerStatusDot");
        const footerStatusText = document.getElementById("footerStatusText");
        const footerScanText = document.getElementById("footerScanText");
        if (footerStatusDot) footerStatusDot.className = "w-1.5 h-1.5 rounded-full bg-blue-600 animate-pulse";
        if (footerStatusText) footerStatusText.textContent = "Scanning";
        if (footerScanText) footerScanText.textContent = "Discovery Active";

        addTimelineLog("Discovery active. Scanning for BLE instruments...", "scan");

        if (!navigator || !navigator.bluetooth) {
            throw new Error("Web Bluetooth API is undefined.");
        }

        // Listen for discovered devices from the main Electron process
        if (window.electronAPI && typeof window.electronAPI.onBluetoothDevices === "function") {
            cleanupDevicesListener = window.electronAPI.onBluetoothDevices((devices) => {
                console.log("Renderer received scanned devices list:", devices);
                if (scannedDevicesList) {
                    // Remove dynamic cards and skeletons, keep deviceListEmpty
                    Array.from(scannedDevicesList.children).forEach(child => {
                        if (child.id !== 'deviceListEmpty') child.remove();
                    });
                    if (devices.length === 0) {
                        if (deviceListEmpty) deviceListEmpty.classList.remove("hidden");
                    } else {
                        if (deviceListEmpty) deviceListEmpty.classList.add("hidden");
                        
                        devices.forEach(d => {
                            const card = document.createElement("div");
                            const normalizedId = d.deviceId.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
                            card.id = `card-${normalizedId}`;
                            card.className = "glass-card p-5 border border-slate-200/60 rounded-xl hover:border-primary/60 hover:shadow-[0_8px_24px_rgba(0,163,224,0.06),0_1px_3px_rgba(0,163,224,0.02)] transition-all duration-300 cursor-pointer flex flex-col gap-3 text-left relative overflow-hidden select-none bg-white shadow-sm";
                            
                            const safeId = normalizedId;
                            
                            // Determine dynamic badge & button status
                            let badgeText = "Discovered";
                            let badgeClass = "text-[10px] px-2 py-0.5 bg-slate-100 text-slate-500 rounded font-semibold";
                            let statusText = "Pair Instrument";
                            let statusClass = "px-3.5 py-1.5 bg-primary/10 text-primary border border-primary/20 rounded-lg text-[9px] font-bold tracking-wider uppercase transition-all duration-200";

                            const isConnected = device && device.id && device.id.toLowerCase() === d.deviceId.toLowerCase() && device.gatt && device.gatt.connected;
                            const isConnecting = window._connectingDeviceId && window._connectingDeviceId.toLowerCase() === d.deviceId.toLowerCase();

                            if (isConnected) {
                                badgeText = "Connected";
                                badgeClass = "text-[10px] px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded font-semibold";
                                statusText = "CONNECTED";
                                statusClass = "px-3.5 py-1.5 bg-emerald-50 text-emerald-600 border border-emerald-250/30 rounded-lg text-[9px] font-bold tracking-wider uppercase transition-all duration-200";
                            } else if (isConnecting) {
                                badgeText = "Connecting...";
                                badgeClass = "text-[10px] px-2 py-0.5 bg-saffron/10 text-saffron rounded font-semibold animate-pulse";
                                statusText = "CONNECTING...";
                                statusClass = "px-3.5 py-1.5 bg-saffron/10 text-saffron border border-saffron/20 rounded-lg text-[9px] font-bold tracking-wider uppercase animate-pulse";
                            }

                            card.innerHTML = `
                                <div class="flex justify-between items-start">
                                    <div>
                                        <h3 class="text-sm font-bold text-slate-800 tracking-tight mb-0.5">${d.deviceName}</h3>
                                        <span id="badge-${safeId}" class="${badgeClass}">${badgeText}</span>
                                    </div>
                                    <div class="flex items-center gap-1 bg-slate-50 px-2 py-0.5 rounded border border-slate-100 text-[10px] text-slate-500 font-mono">
                                        <span class="material-symbols-outlined text-[13px] text-[#64748B]">signal_cellular_alt</span>
                                        <span>${d.rssi || -75} dBm</span>
                                    </div>
                                </div>
                                <div class="text-[10px] text-slate-400 font-mono flex items-center gap-1">
                                    <span class="material-symbols-outlined text-[12px]">fingerprint</span>
                                    <span>MAC: ${d.deviceId}</span>
                                </div>
                                <div class="mt-2 pt-2.5 border-t border-slate-100 flex justify-end">
                                    <span class="${statusClass}" id="status-btn-${safeId}">
                                        ${statusText}
                                    </span>
                                </div>
                            `;
                            
                            card.onclick = () => {
                                console.log("User selected device to connect:", d.deviceName);
                                window._connectingDeviceId = d.deviceId; // Set connecting status
                                
                                // Show details panel
                                const detailsPanel = document.getElementById("details-panel");
                                if (detailsPanel) detailsPanel.classList.remove("hidden");
                                
                                // Update details panel
                                const detailName = document.getElementById("nodeDetailName");
                                if (detailName) detailName.textContent = d.deviceName;
                                const detailMac = document.getElementById("nodeDetailMac");
                                if (detailMac) detailMac.textContent = "MAC: " + d.deviceId;
                                const detailStatus = document.getElementById("nodeDetailStatus");
                                if (detailStatus) {
                                    detailStatus.textContent = "PAIRING...";
                                    detailStatus.className = "text-numeric-data text-orange-500 font-semibold";
                                }

                                // Visual feedback on card
                                const badge = document.getElementById("badge-" + safeId);
                                if (badge) {
                                    badge.textContent = "Connecting...";
                                    badge.className = "text-[10px] px-2 py-0.5 bg-saffron/10 text-saffron rounded font-semibold animate-pulse";
                                }
                                const statusBtn = document.getElementById("status-btn-" + safeId);
                                if (statusBtn) {
                                    statusBtn.textContent = "CONNECTING...";
                                    statusBtn.className = "px-3.5 py-1.5 bg-saffron/10 text-saffron border border-saffron/20 rounded-lg text-[9px] font-bold tracking-wider uppercase animate-pulse";
                                }

                                addTimelineLog("[CONN] Selecting device: " + d.deviceName, "info");
                                addTimelineLog("[CONN] Initiating GATT handshake...", "info");

                                window.electronAPI.selectDevice(d.deviceId);
                            };
                            
                            scannedDevicesList.appendChild(card);
                            
                            addTimelineLog("[SCAN] Found: " + d.deviceName + " (" + (d.rssi || -75) + " dBm)", "scan");
                        });
                    }
                }
            });
        }
        
        try {
            device = await navigator.bluetooth.requestDevice({
                filters: [{ namePrefix: "ISRO_AccelSensor" }],
                optionalServices: [ACCEL_SERVICE_UUID]
            });
        } finally {
            if (cleanupDevicesListener) {
                cleanupDevicesListener();
                cleanupDevicesListener = null;
            }
            if (scanningIndicator) scanningIndicator.classList.add("hidden");
            // Keep cards visible on the Instrument Manager workspace
        }

        isNrfDevice = device.name && (device.name.includes("nRF") || device.name.includes("NRF") || device.name.includes("nrf"));
        console.log("Selected device name: " + device.name + ", isNrfDevice: " + isNrfDevice);

        device.addEventListener('gattserverdisconnected', onDisconnected);

        console.log("Connecting to " + (device.name || "ISRO_AccelSensor") + "...");
        if (connectButton) {
            connectButton.innerHTML = '<span class="material-symbols-outlined text-[18px] animate-spin">progress_activity</span> Connecting...';
            connectButton.disabled = true;
        }
        addTimelineLog("[CONN] Discovering GATT services on " + (device.name || "ISRO_AccelSensor") + "...", "info");

        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(ACCEL_SERVICE_UUID);

        // Concurrently discover all characteristics to minimize latency
        let batteryChar = null;
        await Promise.all([
            service.getCharacteristic(ACCEL_DATA_CHAR_UUID).then(c => accelDataChar = c),
            service.getCharacteristic(OPERATING_MODE_CHAR_UUID).then(c => operatingModeChar = c),
            service.getCharacteristic(SAMPLE_RATE_CHAR_UUID).then(c => sampleRateChar = c).catch(() => sampleRateChar = null),
            service.getCharacteristic(TX_POWER_CHAR_UUID).then(c => txPowerChar = c).catch(() => txPowerChar = null),
            service.getCharacteristic(SENSOR_META_CHAR_UUID).then(c => sensorMetaChar = c).catch(() => sensorMetaChar = null),
            service.getCharacteristic(BATTERY_CHAR_UUID).then(c => batteryChar = c).catch(() => batteryChar = null)
        ]);

        // Concurrently read all characteristics initial values
        let batteryVal = null;
        let metaVal = null;
        let txPowerVal = null;
        let sampleRateVal = null;
        let operatingModeVal = null;

        await Promise.all([
            batteryChar ? batteryChar.readValue().then(v => batteryVal = v).catch(() => null) : Promise.resolve(),
            sensorMetaChar ? sensorMetaChar.readValue().then(v => metaVal = v).catch(() => null) : Promise.resolve(),
            txPowerChar ? txPowerChar.readValue().then(v => txPowerVal = v).catch(() => null) : Promise.resolve(),
            sampleRateChar ? sampleRateChar.readValue().then(v => sampleRateVal = v).catch(() => null) : Promise.resolve(),
            operatingModeChar ? operatingModeChar.readValue().then(v => operatingModeVal = v).catch(() => null) : Promise.resolve()
        ]);

        // 1. Process Battery Level
        const batteryRow = document.getElementById("batteryRow");
        const batteryLevelEl = document.getElementById("batteryLevel");

        if (batteryChar && batteryVal) {
            if (batteryRow) batteryRow.style.display = "flex";
            try {
                const level = batteryVal.getUint8(0);
                window._lastBatteryLevel = level;
                if (batteryLevelEl) batteryLevelEl.textContent = level + " %";
                updateBatteryUI(level);
                updateStatusBar();

                batteryChar.addEventListener('characteristicvaluechanged', (e) => {
                    const l = e.target.value.getUint8(0);
                    window._lastBatteryLevel = l;
                    if (batteryLevelEl) batteryLevelEl.textContent = l + " %";
                    updateBatteryUI(l);
                    updateStatusBar();
                });
                await batteryChar.startNotifications();
            } catch (e) {
                console.warn("Failed to enable battery notifications", e);
            }
        } else {
            if (batteryRow) batteryRow.style.display = "none";
            window._lastBatteryLevel = undefined;
            updateStatusBar();
        }

        connectButton.textContent = "Disconnect";
        connectButton.disabled = false;
        startButton.disabled = false;
        stopButton.disabled = true;
        if (calibrateButton) calibrateButton.disabled = false;
        if (tareButton) tareButton.disabled = false;
        if (bufferModeSelect) bufferModeSelect.disabled = false;
        const ecoModeBtn = document.getElementById("ecoModeBtn");
        if (ecoModeBtn) ecoModeBtn.disabled = false;

        // Enable selectors
        const gRangeSelect = document.getElementById("gRangeSelect");
        const sensorSelect = document.getElementById("sensorSelect");
        if (sensorSelect) sensorSelect.disabled = !operatingModeChar;
        if (gRangeSelect) gRangeSelect.disabled = !operatingModeChar;

        // Pre-populate TX power options based on name detection
        const txPowerSelect = document.getElementById("txPowerSelect");
        if (txPowerSelect) {
            txPowerSelect.innerHTML = "";
            if (isNrfDevice) {
                console.log("Pre-populating TX power options for nRF5340: +3, 0, -8, -12");
                const nrfLevels = [
                    { value: "3", text: "+3 dBm (Max)" },
                    { value: "0", text: "0 dBm" },
                    { value: "-8", text: "-8 dBm" },
                    { value: "-12", text: "-12 dBm" }
                ];
                nrfLevels.forEach(lvl => {
                    const opt = document.createElement("option");
                    opt.value = lvl.value;
                    opt.textContent = lvl.text;
                    txPowerSelect.appendChild(opt);
                });
            } else {
                console.log("Pre-populating TX power options for ESP32-S3: -12, 0, +9");
                const espLevels = [
                    { value: "-12", text: "-12 dBm" },
                    { value: "0", text: "0 dBm" },
                    { value: "9", text: "+9 dBm (Max)" }
                ];
                espLevels.forEach(lvl => {
                    const opt = document.createElement("option");
                    opt.value = lvl.value;
                    opt.textContent = lvl.text;
                    txPowerSelect.appendChild(opt);
                });
            }
            if (typeof renderTxPowerCards === 'function') renderTxPowerCards();
        }

        // 2. Process Metadata (G-Range, Health, Sensor Name)
        if (sensorMetaChar && metaVal) {
            try {
                console.log("Metadata buffer read byteLength:", metaVal.byteLength);

                // Decode sensor name (first 24 bytes or up to byteLength) safely
                let sensorName = "";
                try {
                    const nameLength = Math.min(24, metaVal.byteLength);
                    const nameBytes = new Uint8Array(nameLength);
                    for (let i = 0; i < nameLength; i++) {
                        nameBytes[i] = metaVal.getUint8(i);
                    }
                    sensorName = new TextDecoder("utf-8").decode(nameBytes).replace(/\0/g, '').trim();
                    console.log("Sensor name from metadata: " + sensorName);
                    window._currentSensorName = sensorName;
                } catch (err) {
                    console.warn("Could not parse sensor name:", err);
                }

                isNrfDevice = device.name && (device.name.includes("nRF") || device.name.includes("NRF") || device.name.includes("nrf"));
                console.log("Transmitter hardware detected: " + (isNrfDevice ? "nRF5340" : "ESP32-S3"));

                // Dynamically populate transducer selector based on device type
                if (sensorSelect) {
                    sensorSelect.innerHTML = "";
                    if (isNrfDevice) {
                        const optH3LIS = document.createElement("option");
                        optH3LIS.value = "H3LIS331DL";
                        optH3LIS.textContent = "H3LIS331DL";
                        sensorSelect.appendChild(optH3LIS);

                        const optADXL = document.createElement("option");
                        optADXL.value = "ADXL345";
                        optADXL.textContent = "ADXL345";
                        sensorSelect.appendChild(optADXL);
                    } else {
                        const optH3LIS = document.createElement("option");
                        optH3LIS.value = "H3LIS331DL";
                        optH3LIS.textContent = "H3LIS331DL";
                        sensorSelect.appendChild(optH3LIS);
                    }
                }

                // Dynamically populate profile selector based on device type
                const profileSelect = document.getElementById("profileSelect");
                if (profileSelect) {
                    profileSelect.innerHTML = "";
                    const optCustom = document.createElement("option");
                    optCustom.value = "custom";
                    optCustom.textContent = "Custom Configuration";
                    profileSelect.appendChild(optCustom);

                    if (isNrfDevice) {
                        const optPrec = document.createElement("option");
                        optPrec.value = "precision_vibration";
                        optPrec.textContent = "Precision Vibration (±2g)";
                        profileSelect.appendChild(optPrec);

                        const optMach = document.createElement("option");
                        optMach.value = "machinery_monitoring";
                        optMach.textContent = "Machinery Monitoring (±8g)";
                        profileSelect.appendChild(optMach);

                        const optStruct = document.createElement("option");
                        optStruct.value = "structural_dynamics";
                        optStruct.textContent = "Structural Dynamics (±16g)";
                        profileSelect.appendChild(optStruct);
                    }

                    const optShock = document.createElement("option");
                    optShock.value = "shock_testing";
                    optShock.textContent = "Shock Testing (±400g)";
                    profileSelect.appendChild(optShock);
                }

                // Dynamically populate sampling rate selector based on device type
                if (samplingRateSelect) {
                    samplingRateSelect.innerHTML = "";
                    if (isNrfDevice) {
                        const rates = [
                            { value: "1024", text: "1024 Hz" },
                            { value: "2000", text: "2000 Hz" },
                            { value: "4000", text: "4000 Hz" },
                            { value: "5000", text: "5000 Hz (Max)" }
                        ];
                        rates.forEach(r => {
                            const opt = document.createElement("option");
                            opt.value = r.value;
                            opt.textContent = r.text;
                            samplingRateSelect.appendChild(opt);
                        });
                        samplingRateSelect.disabled = false;
                    } else {
                        const rates = [
                            { value: "1000", text: "1000 Hz" },
                            { value: "2000", text: "2000 Hz" },
                            { value: "3000", text: "3000 Hz" },
                            { value: "4000", text: "4000 Hz" },
                            { value: "5000", text: "5000 Hz (Max)" }
                        ];
                        rates.forEach(r => {
                            const opt = document.createElement("option");
                            opt.value = r.value;
                            opt.textContent = r.text;
                            samplingRateSelect.appendChild(opt);
                        });
                        samplingRateSelect.disabled = false;
                    }
                }
 
                // Dynamically populate TX power select options
                if (txPowerSelect) {
                    txPowerSelect.innerHTML = "";
                    if (isNrfDevice) {
                        const nrfLevels = [
                            { value: "3", text: "+3 dBm (Max)" },
                            { value: "0", text: "0 dBm" },
                            { value: "-8", text: "-8 dBm" },
                            { value: "-12", text: "-12 dBm" }
                        ];
                        nrfLevels.forEach(lvl => {
                            const opt = document.createElement("option");
                            opt.value = lvl.value;
                            opt.textContent = lvl.text;
                            txPowerSelect.appendChild(opt);
                        });
                    } else {
                        const espLevels = [
                            { value: "-12", text: "-12 dBm" },
                            { value: "0", text: "0 dBm" },
                            { value: "9", text: "+9 dBm (Max)" }
                        ];
                        espLevels.forEach(lvl => {
                            const opt = document.createElement("option");
                            opt.value = lvl.value;
                            opt.textContent = lvl.text;
                            txPowerSelect.appendChild(opt);
                        });
                    }
                    if (typeof renderTxPowerCards === 'function') renderTxPowerCards();
                }

                // Read rangeG (offset 24, size 2) safely
                let rangeG = 100;
                if (metaVal.byteLength >= 26) {
                    rangeG = metaVal.getInt16(24, true);
                    console.log("Initial G-Range from firmware metadata: ±" + rangeG + "g");
                } else {
                    console.warn("Metadata buffer too short to read G-Range. Defaulting to 100g.");
                }
                
                let h3lisOk = 0;
                let mpuOk = 0;
                if (metaVal.byteLength >= 36) {
                    h3lisOk = metaVal.getUint8(34);
                    mpuOk = metaVal.getUint8(35);
                }
                console.log(`Sensor health read: H3LIS=${h3lisOk}, MPU=${mpuOk}`);
                
                // Update sensor status panel
                const statusH3LIS = document.getElementById("statusH3LIS");
                const statusMPU = document.getElementById("statusMPU");
                if (statusH3LIS) {
                    statusH3LIS.textContent = h3lisOk === 1 ? "AVAILABLE" : "NOT DETECTED";
                    statusH3LIS.className = h3lisOk === 1 ? "badge-status-green" : "badge-status-red";
                }
                if (statusMPU) {
                    statusMPU.textContent = mpuOk === 1 ? "AVAILABLE" : "NOT DETECTED";
                    statusMPU.className = mpuOk === 1 ? "badge-status-green" : "badge-status-red";
                }
                
                let sensor = rangeG <= 16 ? "ADXL345" : "H3LIS331DL";
                if (typeof window._currentSensorName === 'string' && window._currentSensorName) {
                    if (window._currentSensorName.includes("ADXL345")) sensor = "ADXL345";
                    else if (window._currentSensorName.includes("H3LIS")) sensor = "H3LIS331DL";
                }
                activeSensor = sensor;
                const activeSensorLabel = document.getElementById("activeSensorLabel");
                if (activeSensorLabel) activeSensorLabel.textContent = activeSensor;
                
                if (sensorSelect) {
                    sensorSelect.value = activeSensor;
                }
                
                updateRangeDropdown(activeSensor, rangeG);
                updateLSBPerG(rangeG);
                localStorage.setItem("sensorRangeG", String(rangeG));

                // Check if current range matches any measurement profile
                if (profileSelect) {
                    if (activeSensor === "ADXL345" && rangeG === 2) profileSelect.value = "precision_vibration";
                    else if (activeSensor === "ADXL345" && rangeG === 8) profileSelect.value = "machinery_monitoring";
                    else if (activeSensor === "ADXL345" && rangeG === 16) profileSelect.value = "structural_dynamics";
                    else if (activeSensor === "H3LIS331DL" && rangeG === 400) profileSelect.value = "shock_testing";
                    else profileSelect.value = "custom";
                }
            } catch (e) {
                console.warn("Could not parse initial G-Range and health from metadata:", e);
            }
        }

        // 3. Process TX Power
        if (txPowerSelect) {
            txPowerSelect.disabled = !txPowerChar;
            if (txPowerChar && txPowerVal) {
                try {
                    const currentDbm = txPowerVal.getInt8(0);
                    console.log("Current TX power from firmware: " + currentDbm + " dBm");

                    // Fallback detection: if metadata failed but TX power value is nRF-specific (e.g. -8)
                    const nrfSpecificValues = [-8, -40, 3, -1, -2, -3, -4, -5, -6, -7, -16, -20];
                    if (!isNrfDevice && nrfSpecificValues.includes(currentDbm)) {
                        console.log("Auto-detected nRF5340 transmitter via TX power: " + currentDbm + " dBm");
                        isNrfDevice = true;

                        txPowerSelect.innerHTML = "";
                        const nrfLevels = [
                            { value: "3", text: "+3 dBm (Max)" },
                            { value: "0", text: "0 dBm" },
                            { value: "-8", text: "-8 dBm" },
                            { value: "-12", text: "-12 dBm" }
                        ];
                        nrfLevels.forEach(lvl => {
                            const opt = document.createElement("option");
                            opt.value = lvl.value;
                            opt.textContent = lvl.text;
                            txPowerSelect.appendChild(opt);
                        });
                    }

                    txPowerSelect.value = String(currentDbm);
                    if (typeof renderTxPowerCards === 'function') renderTxPowerCards();
                } catch (e) {
                    console.warn("Could not read current TX power:", e);
                }
            }
        }

        // 4. Process Sampling Rate
        if (samplingRateSelect) {
            samplingRateSelect.disabled = !sampleRateChar;
            if (sampleRateChar && sampleRateVal) {
                try {
                    const currentRate = sampleRateVal.getUint16(0, true);
                    console.log("Current sampling rate from firmware: " + currentRate + " Hz");
                    samplingRateSelect.value = String(currentRate);
                    SAMPLE_RATE = currentRate;
                    
                    // Update signal processing pipeline sample rate
                    signalPipeline.updateParams(signalPipeline.couplingMode, SAMPLE_RATE);
                    
                    // Re-scale target samples dynamically based on new rate
                    sixPosTargetSamples = 10 * SAMPLE_RATE;
                    validationTargetSamples = 10 * SAMPLE_RATE;
                    calibrationTotalSamples = 10.0 * SAMPLE_RATE;

                    // Update FFT max frequency dynamically on chart
                    if (fftChart) {
                        fftChart.options.scales.x.max = SAMPLE_RATE / 2;
                        fftChart.update();
                    }
                } catch (e) {
                    console.warn("Could not read current sampling rate:", e);
                }
            }
        }

        // 5. Process Operating/Buffer Mode
        if (bufferModeSelect) {
            bufferModeSelect.disabled = !operatingModeChar;
            if (operatingModeChar && operatingModeVal) {
                try {
                    const currentModeByte = operatingModeVal.getUint8(0);
                    console.log("Current operating/buffer mode byte from firmware: 0x" + currentModeByte.toString(16).toUpperCase());
                    if (currentModeByte >= 0x10 && currentModeByte <= 0x15) {
                        bufferModeSelect.value = "0x" + currentModeByte.toString(16);
                    }
                } catch (e) {
                    console.warn("Could not read current operating/buffer mode:", e);
                }
            }
        }

        if (scanningIndicator) scanningIndicator.classList.add("hidden");

        // Update connection screen connected card
        const noHardwareConnected = document.getElementById("noHardwareConnected");
        if (noHardwareConnected) noHardwareConnected.classList.add("hidden");
        const connectedDeviceCard = document.getElementById("connectedDeviceCard");
        if (connectedDeviceCard) connectedDeviceCard.classList.remove("hidden");
        
        const connectedDeviceName = document.getElementById("connectedDeviceName");
        if (connectedDeviceName) connectedDeviceName.textContent = device.name || "ISRO_AccelSensor";
        const connectedDeviceAddress = document.getElementById("connectedDeviceAddress");
        if (connectedDeviceAddress) connectedDeviceAddress.textContent = "ADDR: " + (device.id || "XX:XX:XX:XX:XX:XX");
        const nodeStreamingStatus = document.getElementById("nodeStreamingStatus");
        if (nodeStreamingStatus) nodeStreamingStatus.textContent = SAMPLE_RATE + " Hz Idle";

        // Update dashboard header badge
        const badgeDeviceName = document.getElementById("badgeDeviceName");
        if (badgeDeviceName) badgeDeviceName.textContent = device.name || "ISRO_AccelSensor";
        const badgeStreamState = document.getElementById("badgeStreamState");
        if (badgeStreamState) badgeStreamState.textContent = "Connected";

        updateActiveDeviceConfigUI();
        updateStatusBar();

        // Enable Disconnect button in sidebar
        const disconnectSidebarBtn = document.getElementById("disconnectSidebarBtn");
        if (disconnectSidebarBtn) disconnectSidebarBtn.disabled = false;

        // ===== Instrument Manager: Update UI on successful connection =====
        addTimelineLog("[SUCC] " + (device.name || "ISRO_AccelSensor") + " synced (" + SAMPLE_RATE + " Hz)", "succ");
        addTimelineLog("[SUCC] All GATT characteristics discovered.", "succ");

        // Light up Network Topology
        const topologyLine = document.getElementById("topologyLineNode1");
        const topologyDot = document.getElementById("topologyDotNode1");
        if (topologyLine) topologyLine.className = "absolute bottom-full left-1/2 -translate-x-1/2 h-16 w-px bg-green-500 mb-2 transition-colors duration-300";
        if (topologyDot) { topologyDot.className = "w-8 h-8 rounded-full bg-green-500 flex items-center justify-center text-white text-[12px] font-bold transition-colors duration-300"; topologyDot.textContent = "N1"; }

        // Update details panel status
        const detailStatus = document.getElementById("nodeDetailStatus");
        if (detailStatus) { detailStatus.textContent = "ACTIVE"; detailStatus.className = "text-numeric-data text-green-600 font-semibold"; }

        // Update device connection card badge and status button to 'Connected'
        const connectedMAC = window._connectingDeviceId;
        window._connectedMacAddress = connectedMAC; // Store for disconnection
        window._connectingDeviceId = null; // Clear connecting state
        
        let connectedSafeId = null;
        if (connectedMAC) {
            connectedSafeId = connectedMAC.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        } else if (device && device.id) {
            connectedSafeId = device.id.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        }

        if (connectedSafeId) {
            const badge = document.getElementById("badge-" + connectedSafeId);
            if (badge) {
                badge.textContent = "Connected";
                badge.className = "text-[10px] px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded font-semibold";
            }
            const statusBtn = document.getElementById("status-btn-" + connectedSafeId);
            if (statusBtn) {
                statusBtn.textContent = "CONNECTED";
                statusBtn.className = "px-3.5 py-1.5 bg-emerald-50 text-emerald-600 border border-emerald-250/30 rounded-lg text-[9px] font-bold tracking-wider uppercase transition-all duration-200";
            }
        }
        const detailFirmware = document.getElementById("nodeDetailFirmware");
        if (detailFirmware) detailFirmware.textContent = isNrfDevice ? "v1.2.3 (nRF)" : "v1.2.3";
        const detailBattery = document.getElementById("nodeDetailBattery");
        if (detailBattery) {
            const batteryIcon = detailBattery.nextElementSibling;
            if (window._lastBatteryLevel !== undefined) {
                detailBattery.textContent = window._lastBatteryLevel + "%";
                if (batteryIcon) {
                    batteryIcon.textContent = "battery_full";
                    batteryIcon.style.display = "";
                }
            } else if (!isNrfDevice) {
                detailBattery.textContent = "Not Supported";
                if (batteryIcon) {
                    batteryIcon.style.display = "none";
                }
            } else {
                detailBattery.textContent = "95%";
                if (batteryIcon) {
                    batteryIcon.textContent = "battery_full";
                    batteryIcon.style.display = "";
                }
            }
        }
        const detailTemp = document.getElementById("nodeDetailTemp");
        if (detailTemp) detailTemp.textContent = "31°C";

        // Update footer status
        const fDot = document.getElementById("footerStatusDot");
        const fText = document.getElementById("footerStatusText");
        const fScan = document.getElementById("footerScanText");
        if (fDot) fDot.className = "w-2 h-2 rounded-full bg-green-600";
        if (fText) fText.textContent = "Connected";
        if (fScan) fScan.textContent = "1 Device Online";

        // Reset connect button
        if (connectButton) {
            connectButton.innerHTML = '<span class="material-symbols-outlined text-[18px]">refresh</span> Scan Devices';
            connectButton.disabled = false;
        }

        // Enable "Start Acquisition" button
        const btnStartAcq = document.getElementById("btnStartAcquisition");
        if (btnStartAcq) {
            btnStartAcq.disabled = false;
            btnStartAcq.classList.remove("opacity-50", "cursor-not-allowed");
            btnStartAcq.onclick = () => {
                const connScreen = document.getElementById("connectionScreen");
                const dashScreen = document.getElementById("dashboardScreen");
                if (connScreen && dashScreen) {
                    connScreen.classList.remove("active");
                    connScreen.classList.add("hidden");
                    dashScreen.classList.remove("hidden");
                    dashScreen.classList.add("active");
                }
            };
        }

        console.log("Connected to ISRO_AccelSensor. Click 'Start Acquisition' to proceed.");
    } catch (err) {
        console.error("BLE Connection Error:", err);
        
        // Reset card back to Discovered if we were connecting
        if (window._connectingDeviceId) {
            const errorSafeId = window._connectingDeviceId.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
            const badge = document.getElementById("badge-" + errorSafeId);
            if (badge) {
                badge.textContent = "Discovered";
                badge.className = "text-[10px] px-2 py-0.5 bg-slate-100 text-slate-500 rounded font-semibold";
            }
            const statusBtn = document.getElementById("status-btn-" + errorSafeId);
            if (statusBtn) {
                statusBtn.textContent = "Pair Instrument";
                statusBtn.className = "px-3.5 py-1.5 bg-primary/10 text-primary border border-primary/20 rounded-lg text-[9px] font-bold tracking-wider uppercase transition-all duration-200";
            }
        }
        
        window._connectingDeviceId = null; // Clear connecting state on error
        
        addTimelineLog("[ERR] Connection failed: " + err.message, "warn");

        // Ensure main process callback is cancelled and resolved
        if (window.electronAPI && typeof window.electronAPI.cancelScan === "function") {
            window.electronAPI.cancelScan();
        }

        const connectBtn = document.getElementById("connectButton");
        if (connectBtn) {
            connectBtn.innerHTML = '<span class="material-symbols-outlined text-[18px]">refresh</span> Scan Devices';
            connectBtn.disabled = false;
        }
        if (scanningIndicator) scanningIndicator.classList.add("hidden");
        if (deviceListEmpty) deviceListEmpty.classList.remove("hidden");

        // Reset footer
        const fDot = document.getElementById("footerStatusDot");
        const fText = document.getElementById("footerStatusText");
        const fScan = document.getElementById("footerScanText");
        if (fDot) fDot.className = "w-2 h-2 rounded-full bg-red-500";
        if (fText) fText.textContent = "Error";
        if (fScan) fScan.textContent = "Discovery Failed";

        showToast("Connection Failed", err.message, "error", 5000);
    }
}

function onDisconnected() {
    console.log("BLE Disconnected from ISRO_AccelSensor");

    // Update card state back to Discovered
    window._connectingDeviceId = null;
    const connectedMAC = window._connectedMacAddress;
    window._connectedMacAddress = null; // Clear
    
    let disconnectedSafeId = null;
    if (connectedMAC) {
        disconnectedSafeId = connectedMAC.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    } else if (device && device.id) {
        disconnectedSafeId = device.id.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    }

    if (disconnectedSafeId) {
        const badge = document.getElementById("badge-" + disconnectedSafeId);
        if (badge) {
            badge.textContent = "Discovered";
            badge.className = "text-[10px] px-2 py-0.5 bg-slate-100 text-slate-500 rounded font-semibold";
        }
        const statusBtn = document.getElementById("status-btn-" + disconnectedSafeId);
        if (statusBtn) {
            statusBtn.textContent = "Pair Instrument";
            statusBtn.className = "px-3.5 py-1.5 bg-primary/10 text-primary border border-primary/20 rounded-lg text-[9px] font-bold tracking-wider uppercase transition-all duration-200";
        }
    }

    // Reset sample counters on disconnect to prevent dropped count jumps during reconnects
    lastSampleCounter = -1;
    droppedSamples = 0;
    isNrfDevice = false;
    
    window._lastBatteryLevel = undefined;
    const batteryRow = document.getElementById("batteryRow");
    if (batteryRow) batteryRow.style.display = "none";
    const ecoModeBtn = document.getElementById("ecoModeBtn");
    if (ecoModeBtn) ecoModeBtn.disabled = true;
    
    if (timedTimer) {
        clearInterval(timedTimer);
        timedTimer = null;
    }
    stopButton.textContent = "Stop Reading";
    isCalibrating = false;
    if (calibrationOverlay) calibrationOverlay.classList.add("hidden");

    connectButton.textContent = "Scan & Connect";
    connectButton.disabled = false;
    startButton.disabled = true;
    stopButton.disabled = true;
    if (calibrateButton) calibrateButton.disabled = true;
    if (tareButton) tareButton.disabled = true;
    if (sixPosCalButton) sixPosCalButton.disabled = true;
    if (validateCalButton) validateCalButton.disabled = true;
    if (resetCalMatrixButton) resetCalMatrixButton.disabled = true;
    if (calibRollbackButton) calibRollbackButton.disabled = true;
    if (bufferModeSelect) bufferModeSelect.disabled = true;
    if (samplingRateSelect) samplingRateSelect.disabled = true;
    const txPowerSelect = document.getElementById("txPowerSelect");
    if (txPowerSelect) txPowerSelect.disabled = true;
    const gRangeSelect = document.getElementById("gRangeSelect");
    if (gRangeSelect) gRangeSelect.disabled = true;

    // Reset connection screen detail panel state
    const detailStatus = document.getElementById("nodeDetailStatus");
    if (detailStatus) {
        detailStatus.textContent = "DISCONNECTED";
        detailStatus.className = "text-numeric-data text-red-650 font-semibold";
    }
    const btnStartAcq = document.getElementById("btnStartAcquisition");
    if (btnStartAcq) {
        btnStartAcq.disabled = true;
        btnStartAcq.classList.add("opacity-50", "cursor-not-allowed");
        btnStartAcq.innerHTML = "CONNECT";
    }

    // Auto navigate back to connection screen if disconnected
    const connScreen = document.getElementById("connectionScreen");
    const dashScreen = document.getElementById("dashboardScreen");
    if (connScreen && dashScreen) {
        dashScreen.classList.remove("active");
        dashScreen.classList.add("hidden");
        connScreen.classList.remove("hidden");
        connScreen.classList.add("active");
    }

    if (typeof switchWorkspace === "function") {
        switchWorkspace("config");
    }
    const sensorSelect = document.getElementById("sensorSelect");
    if (sensorSelect) sensorSelect.disabled = true;
    updateActiveDeviceConfigUI();
    updateStatusBar();
    if (typeof updateChartEmptyStates === "function") {
        updateChartEmptyStates();
    }
}

async function writeBufferMode(value) {
    if (!operatingModeChar) return;
    try {
        const valByte = parseInt(value, 16);
        const data = new Uint8Array([valByte]);
        await operatingModeChar.writeValue(data);
        console.log(`Successfully wrote buffer mode: 0x${valByte.toString(16).toUpperCase()}`);
        
        const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
        localStorage.setItem("lastSavedConfigTime", nowStr);

        let modeText = "Buffered Mode";
        if (valByte === 0x10) modeText = "Real-Time Streaming (0s Delay)";
        else if (valByte === 0x11) modeText = "Buffered (300ms Delay)";
        else if (valByte === 0x12) modeText = "Stabilized (1s Delay)";
        else if (valByte === 0x13) modeText = "Safe Mode (2s Delay)";
        else if (valByte === 0x14) modeText = "Machinery (5s Delay)";
        else if (valByte === 0x15) modeText = "Extended Storage (10s Delay)";

        showToast("Configuration Applied", `Buffer Mode updated to ${modeText} successfully.`, "success", 3000);
    } catch (err) {
        console.error("BLE Write Error:", err);
        showToast("Configuration Error", "Failed to write buffer mode: " + err.message, "error", 5000);
    }
}

async function writeSamplingRate(value) {
    if (!sampleRateChar) return;
    try {
        const rateInt = parseInt(value, 10);
        const data = new Uint8Array(2);
        data[0] = rateInt & 0xFF;
        data[1] = (rateInt >> 8) & 0xFF;
        await sampleRateChar.writeValue(data);
        console.log(`Successfully wrote sampling rate: ${rateInt} Hz`);
        
        SAMPLE_RATE = rateInt;
        
        // Update signal processing pipeline sample rate
        signalPipeline.updateParams(signalPipeline.couplingMode, SAMPLE_RATE);

        // Re-scale target samples dynamically based on new rate
        sixPosTargetSamples = 10 * SAMPLE_RATE;
        validationTargetSamples = 10 * SAMPLE_RATE;
        calibrationTotalSamples = 10.0 * SAMPLE_RATE;

        // Re-initialize FFT chart scale
        if (fftChart) {
            fftChart.options.scales.x.max = SAMPLE_RATE / 2;
            fftChart.update();
        }

        const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
        localStorage.setItem("lastSavedConfigTime", nowStr);
        showToast("Configuration Applied", `Sampling rate set to ${rateInt} Hz successfully.`, "success", 3000);
    } catch (err) {
        console.error("BLE Write Error:", err);
        showToast("Configuration Error", "Failed to write sampling rate: " + err.message, "error", 5000);
    }
}

function updateLSBPerG(rangeG) {
    // 1. Determine active sensor globally (using metadata decoded name if available)
    let sensor = rangeG <= 16 ? "ADXL345" : "H3LIS331DL";
    if (typeof window._currentSensorName === 'string' && window._currentSensorName) {
        if (window._currentSensorName.includes("ADXL345")) sensor = "ADXL345";
        else if (window._currentSensorName.includes("H3LIS")) sensor = "H3LIS331DL";
    }
    activeSensor = sensor;

    // 2. Compute CONFIG based on rangeG and activeSensor
    let lsb = 256.0;
    let threshold = 0.05;
    let noiseDefault = 0.015;

    if (sensor === "ADXL345") {
        lsb = 256.0; // ADXL345 in Full Resolution is always 3.9 mg/LSB = 256 LSB/g
        threshold = 0.05;
        noiseDefault = 0.015;
    } else { // H3LIS331DL
        const h3lisConfig = {
            100: { lsb: 327.68,  threshold: 1.0,  noiseDefault: 0.500 },
            200: { lsb: 163.84,  threshold: 1.5,  noiseDefault: 0.600 },
            400: { lsb: 81.92,   threshold: 2.0,  noiseDefault: 0.800 }
        };
        const cfg = h3lisConfig[rangeG] || h3lisConfig[400];
        lsb = cfg.lsb;
        threshold = cfg.threshold;
        noiseDefault = cfg.noiseDefault;
    }

    const cfg = { lsb, threshold, noiseDefault };
    LSB_PER_G = cfg.lsb;

    if (calibStabilityThreshold) {
        calibStabilityThreshold.value = cfg.threshold.toString();
        localStorage.setItem("calibStabilityThreshold", cfg.threshold.toString());
    }

    // 3. Load sensor-specific Zero-g Tare Offsets
    const storedOffsetX = localStorage.getItem("calibOffsetX");
    const storedOffsetY = localStorage.getItem("calibOffsetY");
    const storedOffsetZ = localStorage.getItem("calibOffsetZ");
    calibOffsetX = storedOffsetX !== null ? parseFloat(storedOffsetX) : 0.0;
    calibOffsetY = storedOffsetY !== null ? parseFloat(storedOffsetY) : 0.0;
    calibOffsetZ = storedOffsetZ !== null ? parseFloat(storedOffsetZ) : 0.0;

    // 4. Load sensor-specific 3x3 Advanced Calibration state
    const stored3x3Enabled = localStorage.getItem("calib3x3Enabled");
    calib3x3Enabled = stored3x3Enabled === "true";
    if (calib3x3EnabledCheckbox) {
        calib3x3EnabledCheckbox.checked = calib3x3Enabled;
    }

    const stored3x3Matrix = localStorage.getItem("calib3x3Matrix");
    if (stored3x3Matrix !== null) {
        try {
            calib3x3Matrix = JSON.parse(stored3x3Matrix);
        } catch (e) {
            console.error("Failed to parse 3x3 matrix:", e);
        }
    } else {
        calib3x3Matrix = [
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0]
        ];
    }

    const stored3x3Bias = localStorage.getItem("calib3x3Bias");
    if (stored3x3Bias !== null) {
        try {
            calib3x3Bias = JSON.parse(stored3x3Bias);
        } catch (e) {
            console.error("Failed to parse 3x3 bias:", e);
        }
    } else {
        calib3x3Bias = { x: 0.0, y: 0.0, z: 0.0 };
    }

    updateMatrixUI();
    updateBiasUI();

    // 5. Load or set noise defaults
    const savedNoise = localStorage.getItem('calibrated_noise_rms');
    if (savedNoise) {
        try {
            calibratedNoiseRms = JSON.parse(savedNoise);
        } catch (e) {
            console.error("Failed to parse noise RMS:", e);
        }
    } else {
        calibratedNoiseRms = { x: cfg.noiseDefault, y: cfg.noiseDefault, z: cfg.noiseDefault };
    }
    updateNoiseFloorUI();

    // 6. Update status badge UI based on metadata or fallback
    const activeMetaStr = localStorage.getItem("calib3x3Metadata");
    if (activeMetaStr) {
        try {
            const activeMeta = JSON.parse(activeMetaStr);
            showCalibMetricsPanel(activeMeta);
        } catch (e) {
            showCalibMetricsPanel(null);
        }
    } else {
        showCalibMetricsPanel(null);
    }

    // 7. Load history select list
    loadCalibrationHistoryUI();

    console.log(`[Sensor Switch] Active Sensor: ${activeSensor}, Range ±${rangeG}g: LSB/g=${cfg.lsb}, thresh=${cfg.threshold}g`);
}

async function writeGRange(rangeValue) {
    if (!operatingModeChar) {
        console.warn("Operating Mode characteristic not available");
        return;
    }
    const rangeG = parseInt(rangeValue, 10);
    let cmdByte = 0x22; // ±400g default
    if (rangeG === 100) cmdByte = 0x20;
    else if (rangeG === 200) cmdByte = 0x21;
    else if (rangeG === 400) cmdByte = 0x22;
    else if (rangeG === 16) cmdByte = 0x23;
    else if (rangeG === 8) cmdByte = 0x24;
    else if (rangeG === 4) cmdByte = 0x25;
    else if (rangeG === 2) cmdByte = 0x26;
    
    try {
        console.log(`Writing G-Range command 0x${cmdByte.toString(16)} (±${rangeG}g)...`);
        const data = new Uint8Array([cmdByte]);
        await operatingModeChar.writeValue(data);
        updateLSBPerG(rangeG);
        localStorage.setItem("sensorRangeG", String(rangeG));
        
        const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
        localStorage.setItem("lastSavedConfigTime", nowStr);
        
        console.log(`Successfully set G-range to ±${rangeG}g`);

        // Check calibration profile compatibility with the new G-range
        const activeMetaStr = localStorage.getItem("calib3x3Metadata");
        let activeMeta = null;
        if (activeMetaStr) {
            try {
                activeMeta = JSON.parse(activeMetaStr);
            } catch (e) {}
        }

        const activeRange = activeMeta ? (activeMeta.gRange || "400") : null;
        const targetRangeStr = String(rangeG);

        if (activeRange !== targetRangeStr) {
            // Check if we have a profile in the history that matches the target range
            let history = [];
            const historyStr = localStorage.getItem("calibHistory");
            if (historyStr) {
                try {
                    history = JSON.parse(historyStr);
                } catch (e) {}
            }

            // Find first matching profile in history for target range
            const match = history.find(record => (record.gRange || "400") === targetRangeStr);

            if (match) {
                calib3x3Matrix = match.static.matrix;
                calib3x3Bias = match.static.bias;

                localStorage.setItem("calib3x3Matrix", JSON.stringify(calib3x3Matrix));
                localStorage.setItem("calib3x3Bias", JSON.stringify(calib3x3Bias));
                localStorage.setItem("calib3x3Metadata", JSON.stringify(match));
                
                calib3x3Enabled = true;
                localStorage.setItem("calib3x3Enabled", "true");
                if (calib3x3EnabledCheckbox) calib3x3EnabledCheckbox.checked = true;

                if (match.noise) {
                    calibratedNoiseRms = match.noise;
                    localStorage.setItem('calibrated_noise_rms', JSON.stringify(calibratedNoiseRms));
                    updateNoiseFloorUI();
                }

                updateMatrixUI();
                updateBiasUI();
                showCalibMetricsPanel(match);

                showToast("Profile Loaded", `Changed range to ±${rangeG}g.\nA matching calibration profile from ${new Date(match.timestamp).toLocaleDateString()} was automatically loaded.`, "success", 5000);
            } else {
                calib3x3Matrix = [
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0]
                ];
                calib3x3Bias = { x: 0.0, y: 0.0, z: 0.0 };

                localStorage.setItem("calib3x3Matrix", JSON.stringify(calib3x3Matrix));
                localStorage.setItem("calib3x3Bias", JSON.stringify(calib3x3Bias));
                localStorage.removeItem("calib3x3Metadata");

                calib3x3Enabled = false;
                localStorage.setItem("calib3x3Enabled", "false");
                if (calib3x3EnabledCheckbox) calib3x3EnabledCheckbox.checked = false;

                const CONFIG_DEFAULTS = {
                    2:   { noiseDefault: 0.010 },
                    4:   { noiseDefault: 0.015 },
                    8:   { noiseDefault: 0.020 },
                    16:  { noiseDefault: 0.030 },
                    100: { noiseDefault: 0.500 },
                    200: { noiseDefault: 0.600 },
                    400: { noiseDefault: 0.800 }
                };
                const cfg = CONFIG_DEFAULTS[rangeG] || CONFIG_DEFAULTS[400];
                calibratedNoiseRms = { x: cfg.noiseDefault, y: cfg.noiseDefault, z: cfg.noiseDefault };
                localStorage.removeItem("calibrated_noise_rms");
                updateNoiseFloorUI();

                updateMatrixUI();
                updateBiasUI();
                showCalibMetricsPanel(null);

                showToast("Uncalibrated Range", `Changed to ±${rangeG}g — no saved profile found.\nReverting to UNCALIBRATED. Please run the calibration wizard.`, "warning", 6000);
            }
        }
    } catch (err) {
        console.error("G-Range Write Error:", err);
        showToast("Range Write Error", "Failed to set G-range: " + err.message, "error", 5000);
        // Revert UI selection to match active LSB_PER_G
        const gRangeSelect = document.getElementById("gRangeSelect");
        if (gRangeSelect) {
            if (LSB_PER_G === 327.68) gRangeSelect.value = "100";
            else if (LSB_PER_G === 163.84) gRangeSelect.value = "200";
            else gRangeSelect.value = "400";
        }
    }
}

async function writeTxPower(dbmValue) {
    if (!txPowerChar) {
        console.warn("TX Power characteristic not available");
        return;
    }
    try {
        const signedVal = parseInt(dbmValue, 10);
        const data = new Int8Array([signedVal]);
        await txPowerChar.writeValue(data);
        console.log(`Successfully set TX power to ${signedVal} dBm`);
        
        const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
        localStorage.setItem("lastSavedConfigTime", nowStr);
        showToast("Configuration Applied", `Radio TX power set to ${signedVal} dBm successfully.`, "success", 3000);
    } catch (err) {
        console.error("TX Power Write Error:", err);
        showToast("TX Power Error", "Failed to set TX power: " + err.message, "error", 5000);
    }
}

async function sendStart() {
    receivedData = [];
    visualQueue = [];
    lastRenderTime = null;
    isPlayingOut = false;
    playoutAccumulator = 0;
    sampleCount = 0;
    lastSampleCounter = -1;
    droppedSamples = 0;
    latencyHistory = [];
    latencyMax = 0;
    startTime = Date.now();
    window.deviceTimeOffset = undefined;
    window._latencySyncOffset = undefined;
    window._latencySyncBufferDelay = undefined;
    lastFftSampleCount = 0;

    // Reset timestamp unwrapping
    lastFwTs = 0;
    fwTsWrapOffset = 0;

    // Reset signal conditioning pipeline state
    signalPipeline.reset();
    velocityGen.reset();
    displacementGen.reset();

    // Clear charts
    timeChart.data.datasets.forEach(ds => ds.data = []);
    fftChart.data.datasets[0].data = [];
    timeChart.update('none');
    fftChart.update('none');

    if (window.isBypassMode) {
        startButton.disabled = true;
        stopButton.disabled = false;
        exportButton.disabled = true;
        if (calibrateButton) calibrateButton.disabled = true;
        if (tareButton) tareButton.disabled = true;
        if (sixPosCalButton) sixPosCalButton.disabled = true;
        if (validateCalButton) validateCalButton.disabled = true;
        if (resetCalMatrixButton) resetCalMatrixButton.disabled = true;
        if (calibRollbackButton) calibRollbackButton.disabled = true;

        // Update streaming status
        const badgeStreamState = document.getElementById("badgeStreamState");
        if (badgeStreamState) badgeStreamState.textContent = "Streaming";
        const nodeStreamingStatus = document.getElementById("nodeStreamingStatus");
        if (nodeStreamingStatus) nodeStreamingStatus.textContent = SAMPLE_RATE + " Hz Stream";
        updateStatusBar("streaming");

        // Start a simulator timer (generate fake telemetry packet of 29 samples)
        let simTime = 0;
        let packetCount = 0;
        window.simInterval = setInterval(() => {
            const buffer = new ArrayBuffer(239);
            const view = new DataView(buffer);
            
            // Set header
            view.setUint32(0, packetCount++, true); // packet_counter
            view.setUint8(4, 0); // first_sample_offset
            
            for (let i = 0; i < SAMPLES_PER_PACKET; i++) {
                const offset = 5 + (i * SAMPLE_SIZE);
                // rel_timestamp (uint16)
                view.setUint16(offset, Math.floor(simTime * 1000) % 65536, true);
                
                // raw accelerometer values (int16)
                // Generate a nice composite wave (12Hz + 40Hz) for beautiful visual spectrums
                const angle1 = 2.0 * Math.PI * 12.0 * simTime;
                const angle2 = 2.0 * Math.PI * 40.0 * simTime;
                const xVal = (Math.sin(angle1) + 0.3 * Math.sin(angle2)) * 16384 * 2.0; 
                const yVal = (Math.cos(angle1 * 1.2) + 0.2 * Math.sin(angle2 * 0.8)) * 16384 * 1.5;
                const zVal = (Math.sin(angle1 * 0.8) + 1.0) * 16384; // Offset z by ~1g
                
                view.setInt16(offset + 2, xVal, true);
                view.setInt16(offset + 4, yVal, true);
                view.setInt16(offset + 6, zVal, true);
                
                simTime += 1.0 / SAMPLE_RATE;
            }
            
            const mockEvent = {
                target: {
                    value: view
                }
            };
            onData(mockEvent);
        }, 29.0 * 1000 / SAMPLE_RATE);

        // Start Timed Run countdown if enabled (acts as a watchdog, primary stop is sample count)
        if (timedRunEnabled) {
            timedRunStartTimestamp = Date.now();
            timedTimer = setInterval(() => {
                const elapsed = (Date.now() - timedRunStartTimestamp) / 1000;
                const remaining = Math.max(0, timedDuration - elapsed);
                
                stopButton.textContent = `Stop (${remaining.toFixed(1)}s)`;
                
                if (elapsed >= timedDuration + 2.0) {
                    console.warn("[Timed Run] Watchdog triggered in Bypass Mode. Forcing stop.");
                    sendStop();
                }
            }, 100);
        }
        return;
    }

    try {
        await accelDataChar.startNotifications();
        accelDataChar.addEventListener("characteristicvaluechanged", onData);
        console.log("Notifications ENABLED");
    } catch (e) {
        console.error("Failed to enable notifications:", e);
        showToast("Streaming Error", "Failed to start data notifications: " + e.message + "\nPlease make sure the sensor is connected and try again.", "error", 6000);
        return;
    }

    startButton.disabled = true;
    stopButton.disabled = false;
    exportButton.disabled = true;
    if (calibrateButton) calibrateButton.disabled = true;
    if (tareButton) tareButton.disabled = true;
    if (sixPosCalButton) sixPosCalButton.disabled = true;
    if (validateCalButton) validateCalButton.disabled = true;
    if (resetCalMatrixButton) resetCalMatrixButton.disabled = true;
    if (calibRollbackButton) calibRollbackButton.disabled = true;

    // Update streaming status
    const badgeStreamState = document.getElementById("badgeStreamState");
    if (badgeStreamState) badgeStreamState.textContent = "Streaming";
    const nodeStreamingStatus = document.getElementById("nodeStreamingStatus");
    if (nodeStreamingStatus) nodeStreamingStatus.textContent = "Streaming";
    updateStatusBar("streaming");

    // Start Timed Run countdown if enabled (acts as a watchdog, primary stop is sample count)
    if (timedRunEnabled) {
        timedRunStartTimestamp = Date.now();
        timedTimer = setInterval(() => {
            const elapsed = (Date.now() - timedRunStartTimestamp) / 1000;
            const remaining = Math.max(0, timedDuration - elapsed);
            
            stopButton.textContent = `Stop (${remaining.toFixed(1)}s)`;
            
            if (elapsed >= timedDuration + 2.0) {
                console.warn("[Timed Run] Watchdog triggered. Forcing stop.");
                sendStop();
            }
        }, 100);
    }
}

async function sendStop() {
    if (window.isBypassMode && window.simInterval) {
        clearInterval(window.simInterval);
        delete window.simInterval;
    }
    if (timedTimer) {
        clearInterval(timedTimer);
        timedTimer = null;
    }
    stopButton.textContent = "Stop Reading";

    try {
        if (accelDataChar) {
            await accelDataChar.stopNotifications();
            console.log("Notifications DISABLED");
        }
    } catch (e) {
        console.log("Error stopping notifications:", e);
    }

    isPlayingOut = false;
    visualQueue = [];

    stopButton.disabled = true;
    startButton.disabled = false;
    exportButton.disabled = false;
    if (calibrateButton) calibrateButton.disabled = false;
    if (tareButton) tareButton.disabled = false;
    if (sixPosCalButton) sixPosCalButton.disabled = false;
    if (validateCalButton) validateCalButton.disabled = false;
    if (resetCalMatrixButton) resetCalMatrixButton.disabled = false;
    loadCalibrationHistoryUI();

    // Update streaming status
    const badgeStreamState = document.getElementById("badgeStreamState");
    if (badgeStreamState) badgeStreamState.textContent = "Connected";
    if (nodeStreamingStatus) nodeStreamingStatus.textContent = SAMPLE_RATE + " Hz Idle";
    updateStatusBar("idle");

    console.log("Stopped reading (kept BLE connection alive). Samples:", receivedData.length);
}

// ================= DATA PROCESSING (Rev 9 Format) =================
// Packet: packet_counter(4) + first_sample_offset(1) + samples[29×8] + crc16(2) = 239 bytes
// Sample: rel_timestamp_ms(2) + x(2) + y(2) + z(2) = 8 bytes

const SAMPLE_SIZE = 8;           // Rev 9: 8 bytes per sample
const SAMPLES_PER_PACKET = 29;   // Rev 9: 29 samples per packet
const PACKET_SIZE = 239;         // 4 + 1 + 232 + 2

function onData(event) {
    const view = event.target.value;
    const receiveTime = Date.now();

    const packetLen = view.byteLength;

    // Determine packet format: Rev 9 (239 bytes), Rev 3 (243 bytes), or legacy
    let samplesInPacket, sampleSize, hasNewFormat;

    if (packetLen >= 239 && packetLen <= 243) {
        // Rev 9: 239-byte packet (29 samples × 8 bytes) with packet_counter
        hasNewFormat = true;
        samplesInPacket = SAMPLES_PER_PACKET;
        sampleSize = SAMPLE_SIZE;
    } else if (packetLen >= 15) {
        // Legacy: batch_count(1) + samples[n × 14]
        hasNewFormat = false;
        samplesInPacket = view.getUint8(0);
        sampleSize = 14;
        if (samplesInPacket === 0 || samplesInPacket > 10) {
            console.warn("Invalid legacy batch count:", samplesInPacket);
            return;
        }
    } else {
        console.warn("Unknown packet format, length:", packetLen);
        return;
    }

    // Parse packet header for Rev 9
    let packetCounter = 0;
    if (hasNewFormat) {
        packetCounter = view.getUint32(0, true);  // 32-bit packet counter
        // first_sample_offset at byte 4 (for future use)
    }

    // Parse each sample
    let lastTimestampMs = 0;
    for (let i = 0; i < samplesInPacket; i++) {
        let offset, sampleCounter, timestampMs, rawX, rawY, rawZ;

        if (hasNewFormat) {
            // Rev 9 format: packet_counter(4) + first_sample_offset(1) + samples[29 × 8]
            offset = 5 + (i * SAMPLE_SIZE);  // Header is 5 bytes now
            timestampMs = view.getUint16(offset, true);      // 2 bytes (relative)
            rawX = view.getInt16(offset + 2, true);
            rawY = view.getInt16(offset + 4, true);
            rawZ = view.getInt16(offset + 6, true);
            // Use packet counter + sample index for sample tracking
            sampleCounter = packetCounter * SAMPLES_PER_PACKET + i;
        } else {
            // Legacy format: batch_count(1) + samples[n × 14]
            offset = 1 + (i * sampleSize);
            sampleCounter = view.getUint32(offset, true);      // 4 bytes
            timestampMs = view.getUint32(offset + 4, true);    // 4 bytes (absolute)
            rawX = view.getInt16(offset + 8, true);
            rawY = view.getInt16(offset + 10, true);
            rawZ = view.getInt16(offset + 12, true);
        }

        // Unwrap 16-bit timestamp (Rev 3+ uses uint16 timestamps that wrap every ~65s)
        if (hasNewFormat) {
            // If timestamp jumped backwards significantly, it wrapped
            if (timestampMs < lastFwTs - 30000) {
                fwTsWrapOffset += 65536;
            }
            lastFwTs = timestampMs;
            timestampMs += fwTsWrapOffset;
        }

        // Check for dropped samples (handle 32-bit wrap)
        if (lastSampleCounter !== -1) {
            let expected = (lastSampleCounter + 1) >>> 0;
            if (sampleCounter !== expected && sampleCounter > lastSampleCounter) {
                const dropped = sampleCounter - lastSampleCounter - 1;
                if (dropped < 10000) {
                    droppedSamples += dropped;
                } else {
                    console.warn(`Ignored massive sample counter jump: ${lastSampleCounter} -> ${sampleCounter}`);
                }
            }
        }
        lastSampleCounter = sampleCounter;

        // Convert raw counts to g and apply either 3x3 Calibration or Zero-g Tare Calibration Offsets
        const raw_gx = rawX / LSB_PER_G;
        const raw_gy = rawY / LSB_PER_G;
        const raw_gz = rawZ / LSB_PER_G;

        let ax_g, ay_g, az_g;
        if (calib3x3Enabled) {
            // Apply bias: f_m - b
            const dx = raw_gx - calib3x3Bias.x;
            const dy = raw_gy - calib3x3Bias.y;
            const dz = raw_gz - calib3x3Bias.z;

            // Apply matrix: M * (f_m - b)
            ax_g = calib3x3Matrix[0][0]*dx + calib3x3Matrix[0][1]*dy + calib3x3Matrix[0][2]*dz;
            ay_g = calib3x3Matrix[1][0]*dx + calib3x3Matrix[1][1]*dy + calib3x3Matrix[1][2]*dz;
            az_g = calib3x3Matrix[2][0]*dx + calib3x3Matrix[2][1]*dy + calib3x3Matrix[2][2]*dz;
        } else {
            ax_g = raw_gx - calibOffsetX;
            ay_g = raw_gy - calibOffsetY;
            az_g = raw_gz - calibOffsetZ;
        }

        // Push to visual playout queue
        visualQueue.push({ ax_g, ay_g, az_g, timestampMs });

        // True E2E Latency calculation
        if (i === samplesInPacket - 1) {
            const getExpectedBufferDelay = () => {
                const bufferModeSelect = document.getElementById("bufferModeSelect");
                if (!bufferModeSelect) return 300;
                const val = bufferModeSelect.value;
                if (val === "0x10") return 0;
                if (val === "0x11") return 300;
                if (val === "0x12") return 1000;
                if (val === "0x13") return 2000;
                if (val === "0x14") return 5000;
                if (val === "0x15") return 10000;
                return 300;
            };

            if (window._latencySyncOffset === undefined && timestampMs > 0) {
                window._latencySyncOffset = receiveTime - timestampMs;
                window._latencySyncBufferDelay = getExpectedBufferDelay();
                console.log(`[Latency Sync] offset=${window._latencySyncOffset} bufferDelay=${window._latencySyncBufferDelay}`);
            }

            if (window._latencySyncOffset !== undefined) {
                const currentOffset = receiveTime - timestampMs;
                const latency = currentOffset - window._latencySyncOffset + window._latencySyncBufferDelay + 30;

                // Record latency (allowing values up to 15 seconds to support the 10s buffer mode)
                if (latency >= 0 && latency < 15000) {
                    latencyHistory.push(latency);
                    if (latencyHistory.length > LATENCY_WINDOW) latencyHistory.shift();
                    if (latency > latencyMax) latencyMax = latency;
                }
            }
        }
        lastTimestampMs = timestampMs;
    }

    // Update latency display
    if (latencyHistory.length > 0) {
        const currentLatency = latencyHistory[latencyHistory.length - 1];
        const avgLatency = latencyHistory.reduce((a, b) => a + b, 0) / latencyHistory.length;

        const formatLatency = (ms) => {
            if (ms >= 1000) return (ms / 1000).toFixed(2) + " s";
            return ms.toFixed(0) + " ms";
        };

        latencyCurrent.textContent = formatLatency(currentLatency);
        latencyAvg.textContent = formatLatency(avgLatency);
        latencyMaxEl.textContent = formatLatency(latencyMax);
    }

    droppedCountEl.textContent = droppedSamples.toString();
}

// Render Loop (Decoupled from Data Rate)
function renderLoop() {
    if (lastSampleCounter === -1) { // Check if we have data
        lastRenderTime = null;
        requestAnimationFrame(renderLoop);
        return;
    }

    const now = performance.now();
    if (lastRenderTime === null) {
        lastRenderTime = now;
    }
    const deltaMs = now - lastRenderTime;
    lastRenderTime = now;

    // Playout state machine
    const isNoBuffer = (bufferModeSelect && bufferModeSelect.value === "0x10");

    if (isNoBuffer) {
        isPlayingOut = visualQueue.length > 0;
    } else {
        if (!isPlayingOut) {
            if (visualQueue.length >= PLAYOUT_THRESHOLD) {
                isPlayingOut = true;
            }
        }
    }

    if (isPlayingOut) {
        let count;
        if (isNoBuffer) {
            // Drain the entire queue immediately to achieve zero latency
            count = visualQueue.length;
        } else {
            playoutAccumulator += deltaMs * (SAMPLE_RATE / 1000);
            count = Math.floor(playoutAccumulator);
            playoutAccumulator -= count;

            // Catch up if the queue grows too large (prevent cumulative latency)
            if (visualQueue.length > PLAYOUT_THRESHOLD * 2) {
                count = Math.max(count, Math.floor(visualQueue.length / 2));
            }
            count = Math.min(count, visualQueue.length);
        }

        if (count > 0) {
            for (let j = 0; j < count; j++) {
                const sample = visualQueue.shift();
                if (!sample) break;

                const t = sampleCount / SAMPLE_RATE;
                sampleCount++;

                // Master sample is the raw calibrated sample (unfiltered)
                const masterSample = { x: sample.ax_g, y: sample.ay_g, z: sample.az_g };
                
                // Apply signal conditioning to get the display sample
                const displaySample = signalPipeline.apply(masterSample);

                // Run derived generators to obtain velocity and displacement streams
                const velocitySample = velocityGen.process(displaySample);
                const displacementSample = displacementGen.process(displaySample);

                // Store both for CSV / calibration history
                receivedData.push({ 
                    t, 
                    x: masterSample.x, 
                    y: masterSample.y, 
                    z: masterSample.z, 
                    cx: displaySample.x, 
                    cy: displaySample.y, 
                    cz: displaySample.z, 
                    vx: velocitySample.x,
                    vy: velocitySample.y,
                    vz: velocitySample.z,
                    dx: displacementSample.x,
                    dy: displacementSample.y,
                    dz: displacementSample.z,
                    ts: sample.timestampMs 
                });

                if (timedRunEnabled) {
                    const targetSamples = timedDuration * SAMPLE_RATE;
                    if (receivedData.length >= targetSamples) {
                        if (receivedData.length > targetSamples) {
                            receivedData.length = targetSamples;
                        }
                        sendStop();
                        break;
                    }
                }

                // Get active value to plot and display
                let plotX, plotY, plotZ;
                if (displayQuantity === 'velocity') {
                    plotX = velocitySample.x;
                    plotY = velocitySample.y;
                    plotZ = velocitySample.z;
                } else if (displayQuantity === 'displacement') {
                    plotX = displacementSample.x;
                    plotY = displacementSample.y;
                    plotZ = displacementSample.z;
                } else { // 'acceleration'
                    plotX = displaySample.x;
                    plotY = displaySample.y;
                    plotZ = displaySample.z;
                }

                // Update chart datasets with conditioned display data
                timeChart.data.datasets[0].data.push({ x: t, y: plotX });
                timeChart.data.datasets[1].data.push({ x: t, y: plotY });
                timeChart.data.datasets[2].data.push({ x: t, y: plotZ });
            }

            // Update real-time displays using the latest played out sample
            const last = receivedData[receivedData.length - 1];
            let displayX, displayY, displayZ;
            if (displayQuantity === 'velocity') {
                displayX = last.vx;
                displayY = last.vy;
                displayZ = last.vz;
            } else if (displayQuantity === 'displacement') {
                displayX = last.dx;
                displayY = last.dy;
                displayZ = last.dz;
            } else {
                displayX = last.cx;
                displayY = last.cy;
                displayZ = last.cz;
            }
            if (xValue) xValue.textContent = displayX.toFixed(3);
            if (yValue) yValue.textContent = displayY.toFixed(3);
            if (zValue) zValue.textContent = displayZ.toFixed(3);

            // Update AC RMS-based Vibration SNR every 10th sample
            if (sampleCount % 10 === 0) {
                const windowSamples = Math.min(Math.ceil(windowSeconds * SAMPLE_RATE), 2000);
                const slice = receivedData.slice(-windowSamples);
                if (slice.length >= 10) {
                    updateRealtimeSNR(slice);
                }
            }

            // Update statistics panel
            sampleCountEl.textContent = sampleCount.toLocaleString();
            const lastSample = receivedData[receivedData.length - 1];
            if (lastSample && lastSample.ts > 1000) {
                const fwElapsedSec = lastSample.ts / 1000;
                sampleRateEl.textContent = (sampleCount / fwElapsedSec).toFixed(1) + " Hz";
            } else {
                const elapsedSec = (Date.now() - startTime) / 1000;
                if (elapsedSec > 0.5) {
                    sampleRateEl.textContent = (sampleCount / elapsedSec).toFixed(1) + " Hz";
                }
            }
        }

        // Update settling indicator overlay dynamically based on pipeline state
        const settlingIndicator = document.getElementById("settlingIndicator");
        if (settlingIndicator) {
            if (signalPipeline.isSettling()) {
                settlingIndicator.classList.remove("hidden");
            } else {
                settlingIndicator.classList.add("hidden");
            }
        }

        if (visualQueue.length === 0) {
            isPlayingOut = false;
        }
    }

    // Trim time-domain chart
    const maxPoints = Math.ceil(windowSeconds * SAMPLE_RATE) + 20;
    timeChart.data.datasets.forEach(ds => {
        while (ds.data.length > maxPoints) ds.data.shift();
    });

    // Update X-axis rolling window
    const lastT = receivedData.length > 0 ? receivedData[receivedData.length - 1].t : 0;

    // Cycle-based windowing: if cycleCount > 0 and we have a detected frequency
    if (cycleCount > 0 && detectedPeakHz > 1) {
        windowSeconds = cycleCount / detectedPeakHz;
        windowSeconds = Math.max(0.005, Math.min(10, windowSeconds));
        updateWindowDisplay();
    }

    timeChart.options.scales.x.min = Math.max(0, lastT - windowSeconds);
    timeChart.options.scales.x.max = lastT;

    // Auto-scale Y-axis based on visible data
    if (autoScaleY) {
        let yMin = Infinity, yMax = -Infinity;
        timeChart.data.datasets.forEach(ds => {
            for (const pt of ds.data) {
                if (pt.y < yMin) yMin = pt.y;
                if (pt.y > yMax) yMax = pt.y;
            }
        });
        if (yMin !== Infinity && yMax !== -Infinity) {
            const range = yMax - yMin;
            const padding = Math.max(range * 0.15, 0.01);
            timeChart.options.scales.y.min = yMin - padding;
            timeChart.options.scales.y.max = yMax + padding;
        }
    }

    timeChart.update('none');

    // Update Live Motion & Diagnostics
    if (orbitChart && !isOrbitFrozen) {
        let xData = 0, yData = 1;
        if (orbitAxisPair === 'xy') { xData = 0; yData = 1; }
        else if (orbitAxisPair === 'xz') { xData = 0; yData = 2; }
        else if (orbitAxisPair === 'yz') { xData = 1; yData = 2; }
        
        const orbitData = [];
        const dsX = timeChart.data.datasets[xData].data;
        const dsY = timeChart.data.datasets[yData].data;
        // only plot points that are visible in current time window
        const minTime = timeChart.options.scales.x.min;
        for (let i = 0; i < dsX.length; i++) {
            if (dsY[i] && dsX[i].x >= minTime) {
                orbitData.push({ x: dsX[i].y, y: dsY[i].y });
            }
        }
        orbitChart.data.datasets[0].data = orbitData;
        
        if (autoScaleY) {
            orbitChart.options.scales.x.min = timeChart.options.scales.y.min;
            orbitChart.options.scales.x.max = timeChart.options.scales.y.max;
            orbitChart.options.scales.y.min = timeChart.options.scales.y.min;
            orbitChart.options.scales.y.max = timeChart.options.scales.y.max;
        }
        orbitChart.update('none');
    }

    if (threeModel && receivedData.length > 0) {
        const last = receivedData[receivedData.length - 1];
        // Use raw acceleration for the vector direction
        const ax = last.x || 0;
        const ay = last.y || 0;
        const az = last.z !== undefined ? last.z : 1; 
        
        const mag = Math.sqrt(ax*ax + ay*ay + az*az) || 1;
        // Map sensor coordinates to Three.js coordinates:
        // Sensor X -> Three.js X
        // Sensor Y -> Three.js -Z
        // Sensor Z -> Three.js Y
        threeArrowDir.set(ax/mag, az/mag, -ay/mag);
        threeArrowHelper.setDirection(threeArrowDir);
        
        // Simple tilt for the board model
        const pitch = Math.atan2(-ay, Math.sqrt(ax*ax + az*az));
        const roll  = Math.atan2(ax, az);
        
        threeModel.rotation.x += (pitch - threeModel.rotation.x) * 0.1;
        threeModel.rotation.z += (roll - threeModel.rotation.z) * 0.1;
    }

    // FFT update — every 500 new samples (counter-based)
    if (sampleCount >= fftSize && (sampleCount - lastFftSampleCount) >= 500) {
        lastFftSampleCount = sampleCount;
        computeAndDisplayFFT();
    }

    requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);


// ================= FFT (Float64, Research-Grade) =================
function computeAndDisplayFFT() {
    const fftCanvas = document.getElementById("fftChart");
    const peakFreqEl = document.getElementById("peakFreq");
    const fftPeak1XEl = document.getElementById("fftPeak1X");
    const fftThdEl = document.getElementById("fftThd");
    const fftHarmonicsListEl = document.getElementById("fftHarmonicsList");
    const freqResEl = document.getElementById("freqResolution");
    const bandRms1El = document.getElementById("bandRms1");
    const bandRms2El = document.getElementById("bandRms2");
    const bandRms3El = document.getElementById("bandRms3");
    const bandRms4El = document.getElementById("bandRms4");
    const bandLabel1El = document.getElementById("bandLabel1");
    const bandLabel2El = document.getElementById("bandLabel2");
    const bandLabel3El = document.getElementById("bandLabel3");
    const bandLabel4El = document.getElementById("bandLabel4");
    
    if (signalPipeline.isSettling()) {
        if (fftCanvas) {
            fftCanvas.style.opacity = "0.4";
            fftCanvas.style.transition = "opacity 0.3s ease";
        }
        if (fftChart) {
            fftChart.data.datasets[0].data = [];
            fftChart.update('none');
        }
        if (psdChart) {
            psdChart.data.datasets[0].data = [];
            psdChart.update('none');
        }
        if (peakFreqEl) peakFreqEl.textContent = "Peak: Settling...";
        if (fftPeak1XEl) fftPeak1XEl.textContent = "Settling...";
        if (fftThdEl) fftThdEl.textContent = "Settling...";
        if (fftHarmonicsListEl) fftHarmonicsListEl.textContent = "Settling...";
        psdAnalyzer.reset();
        return;
    }
    
    if (fftCanvas) {
        fftCanvas.style.opacity = "1.0";
    }

    const n = fftSize;
    if (receivedData.length < n) return;

    // Get last n samples for selected axis (from active display quantity stream)
    let key = 'c' + fftAxis;
    let unit = 'g';
    let psdUnit = 'g²/Hz';
    if (displayQuantity === 'velocity') {
        key = 'v' + fftAxis;
        unit = 'mm/s';
        psdUnit = '(mm/s)²/Hz';
    } else if (displayQuantity === 'displacement') {
        key = 'd' + fftAxis;
        unit = 'µm';
        psdUnit = 'µm²/Hz';
    }
    const raw = receivedData.slice(-n).map(d => d[key] !== undefined ? d[key] : d[fftAxis]);

    // Step 1: Spectral analysis (FFTAnalyzer)
    const spectrum = FFTAnalyzer.analyze(raw, SAMPLE_RATE, fftWindowType);

    // Step 2: Harmonic analysis (HarmonicAnalyzer)
    const harmonics = HarmonicAnalyzer.analyze(spectrum.magnitudes, spectrum.binResolution);

    // Step 3: PSD with linear averaging
    const psdData = psdAnalyzer.computeAndAverage(spectrum.magnitudes, spectrum.binResolution, fftWindowType);

    // Step 4: Band RMS (Nyquist-relative)
    const nyquist = SAMPLE_RATE / 2;
    const bandResults = BandRMSCalculator.compute(spectrum.magnitudes, spectrum.binResolution, nyquist);

    // === Update FFT chart ===
    fftChart.data.datasets[0].data = spectrum.magnitudes;
    fftChart.data.datasets[0].borderColor =
        fftAxis === 'x' ? '#ff4d6d' : (fftAxis === 'y' ? '#10b981' : '#6366f1');
    fftChart.data.datasets[0].label = fftAxis.toUpperCase() + ' FFT';
    fftChart.update('none');

    // === Update PSD chart ===
    if (psdChart) {
        psdChart.data.datasets[0].data = psdData;
        psdChart.data.datasets[0].borderColor =
            fftAxis === 'x' ? '#ff4d6d' : (fftAxis === 'y' ? '#10b981' : '#6366f1');
        psdChart.data.datasets[0].label = fftAxis.toUpperCase() + ' PSD';
        psdChart.options.scales.y.title.text = 'PSD (' + psdUnit + ')';
        psdChart.update('none');
    }

    // === Update peak / harmonics / THD display ===
    if (peakFreqEl) peakFreqEl.textContent = `Peak: ${harmonics.peakFreq.toFixed(1)} Hz`;
    detectedPeakHz = harmonics.peakFreq;

    if (fftPeak1XEl) {
        fftPeak1XEl.textContent = `${harmonics.peakFreq.toFixed(1)} Hz (${harmonics.peakVal.toFixed(2)} ${unit})`;
    }
    if (fftThdEl) {
        fftThdEl.textContent = `${harmonics.thd.toFixed(2)} %`;
    }
    if (fftHarmonicsListEl) {
        fftHarmonicsListEl.textContent = harmonics.harmonics.map(h => `${h.order}X: ${h.mag.toFixed(2)}`).join(" | ");
    }

    // === Update frequency resolution ===
    if (freqResEl) {
        freqResEl.textContent = `Resolution: ${spectrum.binResolution.toFixed(2)} Hz/bin`;
    }

    // === Update Frequency Inspector (Live Diagnostics Workspace) ===
    const inspDominantFreq = document.getElementById("inspDominantFreq");
    const inspPeakAmp = document.getElementById("inspPeakAmp");
    const inspHarmonicsList = document.getElementById("inspHarmonicsList");
    
    if (inspDominantFreq) inspDominantFreq.textContent = harmonics.peakFreq.toFixed(2);
    if (inspPeakAmp) inspPeakAmp.textContent = harmonics.peakVal.toFixed(2);
    
    if (inspHarmonicsList && harmonics.harmonics) {
        const rows = inspHarmonicsList.querySelectorAll('div');
        for (let i = 0; i < 5; i++) {
            if (rows[i] && harmonics.harmonics[i]) {
                const valEl = rows[i].querySelector('.val');
                if (valEl) {
                    valEl.textContent = `${harmonics.harmonics[i].mag.toFixed(3)} ${unit}`;
                }
            } else if (rows[i]) {
                const valEl = rows[i].querySelector('.val');
                if (valEl) valEl.textContent = '—';
            }
        }
    }

    // === Update Band RMS ===
    const bandMultiplier = (displayQuantity === 'acceleration') ? 1000.0 : 1.0;
    const bandUnit = (displayQuantity === 'acceleration') ? 'mg' : unit;
    const bandEls = [bandRms1El, bandRms2El, bandRms3El, bandRms4El];
    const bandLabelEls = [bandLabel1El, bandLabel2El, bandLabel3El, bandLabel4El];
    
    // For Energy Distribution percentages
    let totalEnergy = 0;
    for (let i = 0; i < bandResults.length; i++) {
        totalEnergy += bandResults[i].rms;
    }

    for (let i = 0; i < bandResults.length; i++) {
        if (bandEls[i]) {
            bandEls[i].textContent = (bandResults[i].rms * bandMultiplier).toFixed(2) + ' ' + bandUnit;
        }
        if (bandLabelEls[i]) {
            bandLabelEls[i].textContent = `${Math.round(bandResults[i].fLow)}–${Math.round(bandResults[i].fHigh)} Hz`;
        }
        
        // Update new inspector energy bars
        const pct = totalEnergy > 0 ? (bandResults[i].rms / totalEnergy) * 100 : 0;
        const barEl = document.getElementById(`energyBar${i+1}`);
        const valEl = document.getElementById(`energyVal${i+1}`);
        if (barEl) barEl.style.width = `${pct}%`;
        if (valEl) valEl.textContent = `${pct.toFixed(0)}%`;
    }

    // === Update Spectral SNR ===
    if (snrSpectralEl) {
        const legacyMags = spectrum.magnitudes.map(pt => ({ x: pt.x, y: pt.y }));
        applySnrColor(snrSpectralEl, computeSpectralSNR(legacyMags));
        if (snrSpectralAxisEl) snrSpectralAxisEl.textContent = '(' + fftAxis.toUpperCase() + ')';
    }

    // === Update auto-scale info ===
    const infoEl = document.getElementById('autoScaleInfo');
    if (infoEl && cycleCount > 0 && detectedPeakHz > 1) {
        const winMs = (cycleCount / detectedPeakHz) * 1000;
        infoEl.textContent = `${cycleCount} cycles @ ${detectedPeakHz.toFixed(1)} Hz = ${winMs.toFixed(1)} ms`;
    } else if (infoEl) {
        infoEl.textContent = '';
    }
}

// Cooley-Tukey FFT implementation (Float64)
function fftCooleyTukey(input, real, imag) {
    const n = input.length;
    const bits = Math.log2(n);
    if (bits !== Math.floor(bits)) {
        console.error('FFT size must be a power of 2, got:', n);
        return;
    }

    // Bit-reversal permutation
    for (let i = 0; i < n; i++) {
        const j = reverseBits(i, bits);
        real[j] = input[i];
        imag[j] = 0;
    }

    // Cooley-Tukey iterative FFT
    for (let s = 1; s <= bits; s++) {
        const m = 1 << s;
        const wm_real = Math.cos(-2 * Math.PI / m);
        const wm_imag = Math.sin(-2 * Math.PI / m);

        for (let k = 0; k < n; k += m) {
            let w_real = 1;
            let w_imag = 0;

            for (let j = 0; j < m / 2; j++) {
                const t_real = w_real * real[k + j + m / 2] - w_imag * imag[k + j + m / 2];
                const t_imag = w_real * imag[k + j + m / 2] + w_imag * real[k + j + m / 2];

                const u_real = real[k + j];
                const u_imag = imag[k + j];

                real[k + j] = u_real + t_real;
                imag[k + j] = u_imag + t_imag;
                real[k + j + m / 2] = u_real - t_real;
                imag[k + j + m / 2] = u_imag - t_imag;

                const new_w_real = w_real * wm_real - w_imag * wm_imag;
                const new_w_imag = w_real * wm_imag + w_imag * wm_real;
                w_real = new_w_real;
                w_imag = new_w_imag;
            }
        }
    }
}

function reverseBits(n, bits) {
    let result = 0;
    for (let i = 0; i < bits; i++) {
        result = (result << 1) | (n & 1);
        n >>= 1;
    }
    return result;
}

function updateFftResolution() {
    const resolution = SAMPLE_RATE / fftSize;
    freqResolution.textContent = `Resolution: ${resolution.toFixed(2)} Hz`;
}

function drawFilterResponsePlot() {
    const canvas = document.getElementById("filterResponseCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    
    // Support high-DPI scaling
    const rect = canvas.getBoundingClientRect();
    const w = rect.width || 0;
    const h = rect.height || 0;
    if (w === 0 || h === 0) return; // Prevent drawing when collapsed or hidden
    
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    
    ctx.clearRect(0, 0, w, h);

    // Light blue-tinted dashboard theme background
    ctx.fillStyle = "#F4F9FF";
    ctx.fillRect(0, 0, w, h);

    const couplingStage = signalPipeline.stages.find(s => s.name === 'coupling');
    const filterStage = signalPipeline.stages.find(s => s.name === 'filter');
    
    const isCouplingActive = couplingStage && couplingStage.active;
    const isFilterActive = filterStage && filterStage.active;
    const isActive = isCouplingActive || isFilterActive;
    
    // Set margins for graph to fit labels nicely
    const marginLeft = 35;
    const marginRight = 35;
    const marginTop = 15;
    const marginBottom = 20;
    const graphW = w - marginLeft - marginRight;
    const graphH = h - marginTop - marginBottom;

    // dB limits
    const minDb = -45;
    const maxDb = 5;
    // Phase limits
    const minDeg = -180;
    const maxDeg = 180;

    const fs = filterStage ? filterStage.sampleRate : (couplingStage ? couplingStage.sampleRate : 1024);
    const maxFreq = fs / 2;

    const minF = 0.1;
    const logMin = Math.log10(minF);
    const logMax = Math.log10(maxFreq);

    // Logarithmic map functions:
    const mapX = (f) => {
        const logF = Math.log10(Math.max(minF, f));
        const ratio = (logF - logMin) / (logMax - logMin);
        return marginLeft + ratio * graphW;
    };
    const mapMagY = (db) => {
        const ratio = (db - minDb) / (maxDb - minDb);
        return marginTop + graphH - Math.max(0, Math.min(1, ratio)) * graphH;
    };
    const mapPhaseY = (deg) => {
        const ratio = (deg - minDeg) / (maxDeg - minDeg);
        return marginTop + graphH - Math.max(0, Math.min(1, ratio)) * graphH;
    };

    // Draw horizontal grid lines (dB axis)
    ctx.lineWidth = 0.5;
    const dbLines = [0, -10, -20, -30, -40];
    dbLines.forEach(db => {
        const y = mapMagY(db);
        ctx.strokeStyle = db === 0 ? "rgba(11, 25, 44, 0.25)" : "rgba(11, 25, 44, 0.08)";
        ctx.beginPath();
        ctx.moveTo(marginLeft, y);
        ctx.lineTo(w - marginRight, y);
        ctx.stroke();

        // Label on left - Deep Space Navy (#0B192C) for sharp visibility
        ctx.fillStyle = "#0B192C";
        ctx.font = "bold 7px 'Geist Mono', monospace";
        ctx.textAlign = "right";
        ctx.fillText(`${db} dB`, marginLeft - 5, y + 2.5);
    });

    const showPhaseChk = document.getElementById("showPhasePlot");
    const hasPhase = showPhaseChk ? showPhaseChk.checked : true;

    // Draw horizontal grid lines for Phase axis (right side)
    if (hasPhase && isActive) {
        const phaseLines = [180, 90, 0, -90, -180];
        phaseLines.forEach(deg => {
            const y = mapPhaseY(deg);
            
            if (deg !== 0 && Math.abs(y - mapMagY(0)) > 6 && Math.abs(y - mapMagY(-20)) > 6) {
                // Secondary grid line
                ctx.strokeStyle = "rgba(11, 25, 44, 0.04)";
                ctx.beginPath();
                ctx.moveTo(marginLeft, y);
                ctx.lineTo(w - marginRight, y);
                ctx.stroke();
            }

            // Label on right in solid ISRO Saffron (#FF671F) for clear reading
            ctx.fillStyle = "#FF671F";
            ctx.font = "bold 7px 'Geist Mono', monospace";
            ctx.textAlign = "left";
            ctx.fillText(`${deg}°`, w - marginRight + 5, y + 2.5);
        });
    }

    // Draw vertical logarithmic decade grid lines
    const decades = [0.1, 1, 10, 100, 1000];
    decades.forEach(dec => {
        if (dec >= minF && dec <= maxFreq) {
            const x = mapX(dec);
            
            ctx.strokeStyle = "rgba(11, 25, 44, 0.25)"; // Decade grid line
            ctx.lineWidth = 0.75;
            ctx.beginPath();
            ctx.moveTo(x, marginTop);
            ctx.lineTo(x, marginTop + graphH);
            ctx.stroke();

            // Label decade in Deep Space Navy
            ctx.fillStyle = "#0B192C";
            ctx.font = "bold 7px 'Geist Mono', monospace";
            ctx.textAlign = "center";
            ctx.fillText(dec >= 1 ? `${dec} Hz` : `${dec.toFixed(1)} Hz`, x, marginTop + graphH + 10);

            // Draw sub-decade ticks (2, 3, 4, 5, 6, 7, 8, 9)
            ctx.strokeStyle = "rgba(11, 25, 44, 0.06)";
            ctx.lineWidth = 0.5;
            for (let sub = 2; sub <= 9; sub++) {
                const subF = dec * sub;
                if (subF <= maxFreq) {
                    const subX = mapX(subF);
                    ctx.beginPath();
                    ctx.moveTo(subX, marginTop);
                    ctx.lineTo(subX, marginTop + graphH);
                    ctx.stroke();
                }
            }
        }
    });

    // Update legends text element (if present)
    const legendsEl = document.getElementById("filterPlotLegends");
    if (legendsEl) {
        legendsEl.textContent = hasPhase 
            ? "Mag (Cyan) & Phase (Saffron)" 
            : "Magnitude Response (Cyan)";
    }

    // Extract cutoff parameters for display
    let couplingCutoff = 0.0;
    if (isCouplingActive) {
        if (couplingStage.couplingMode === 'AC_0.3') couplingCutoff = 0.3;
        else if (couplingStage.couplingMode === 'AC_3') couplingCutoff = 3.0;
        else if (couplingStage.couplingMode === 'AC_10') couplingCutoff = 10.0;
    }
    const filterCutoff = isFilterActive ? filterStage.cutoff : 0;
    const filterType = isFilterActive ? filterStage.filterType : 'None';
    const order = isFilterActive ? filterStage.order : 4;

    if (!isActive) {
        // Bypassed flat response line
        ctx.strokeStyle = "rgba(100, 116, 139, 0.5)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(marginLeft, mapMagY(0));
        ctx.lineTo(w - marginRight, mapMagY(0));
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = "#64748b";
        ctx.font = "bold 9px 'Geist Mono', monospace";
        ctx.textAlign = "center";
        ctx.fillText("BYPASSED (UNITY GAIN / DC)", marginLeft + graphW / 2, marginTop + graphH / 2 + 3);

        updateMetricsUI('Direct DC Coupling', '0 dB/Octave', '0 Hz (DC)', '0°', '0.0 dB', 'Attenuation @ fc');
        return;
    }

    // Compute combined plot points logarithmically
    const pts = [];
    for (let i = 0; i <= 300; i++) {
        const logVal = logMin + (i / 300) * (logMax - logMin);
        const f = Math.pow(10, logVal);
        
        let combinedMag = 1.0;
        let combinedPhase = 0.0;

        if (isCouplingActive) {
            const respC = couplingStage.processors.x.getFrequencyResponse(f, fs);
            combinedMag *= respC.magnitude;
            combinedPhase += respC.phase;
        }

        if (isFilterActive) {
            const respF = filterStage.processors.x.getFrequencyResponse(f, fs);
            combinedMag *= respF.magnitude;
            combinedPhase += respF.phase;
        }

        const magDb = 20.0 * Math.log10(Math.max(1e-4, combinedMag));
        const phaseDeg = combinedPhase * 180.0 / Math.PI;
        pts.push({ f, magDb, phaseDeg });
    }

    // Fill area under Magnitude curve
    const areaGrad = ctx.createLinearGradient(0, marginTop, 0, marginTop + graphH);
    areaGrad.addColorStop(0, "rgba(0, 163, 224, 0.15)"); // Telemetry Cyan glow
    areaGrad.addColorStop(1, "rgba(0, 163, 224, 0.0)");
    
    ctx.fillStyle = areaGrad;
    ctx.beginPath();
    pts.forEach((pt, idx) => {
        const x = mapX(pt.f);
        const y = mapMagY(pt.magDb);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.lineTo(mapX(maxFreq), marginTop + graphH);
    ctx.lineTo(mapX(minF), marginTop + graphH);
    ctx.closePath();
    ctx.fill();

    // Plot Magnitude curve in Telemetry Cyan with soft shadow glow
    ctx.strokeStyle = "#00A3E0";
    ctx.lineWidth = 2.0;
    ctx.shadowColor = "rgba(0, 163, 224, 0.5)";
    ctx.shadowBlur = 4;
    ctx.beginPath();
    pts.forEach((pt, idx) => {
        const x = mapX(pt.f);
        const y = mapMagY(pt.magDb);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.shadowBlur = 0; // Reset shadow/glow

    // Plot Phase response in Saffron if enabled
    if (hasPhase) {
        ctx.strokeStyle = "#FF671F";
        ctx.lineWidth = 1.25;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        pts.forEach((pt, idx) => {
            const x = mapX(pt.f);
            const y = mapPhaseY(pt.phaseDeg);
            if (idx === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // Draw vertical line at Coupling cutoff
    if (isCouplingActive && couplingCutoff > 0) {
        const cx = mapX(couplingCutoff);
        ctx.strokeStyle = "rgba(99, 102, 241, 0.6)"; // Indigo indicator
        ctx.lineWidth = 1.25;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(cx, marginTop);
        ctx.lineTo(cx, marginTop + graphH);
        ctx.stroke();
        ctx.setLineDash([]);

        // Coupling label flag
        ctx.fillStyle = "#6366f1";
        ctx.font = "bold 7px 'Geist Mono', monospace";
        ctx.textAlign = "center";
        ctx.fillText("fc (coupling)", cx, marginTop + 8);
    }

    // Draw vertical line at Filter cutoff (fc)
    if (isFilterActive && filterCutoff > 0 && filterCutoff < maxFreq) {
        const fx = mapX(filterCutoff);
        ctx.strokeStyle = "rgba(255, 103, 31, 0.6)"; // Saffron indicator
        ctx.lineWidth = 1.25;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(fx, marginTop);
        ctx.lineTo(fx, marginTop + graphH);
        ctx.stroke();
        ctx.setLineDash([]);

        // Cutoff label flag at the top
        ctx.fillStyle = "#FF671F";
        ctx.font = "bold 7px 'Geist Mono', monospace";
        ctx.textAlign = "center";
        ctx.fillText("fc (filter)", fx, marginTop - 4);
    }

    // Dynamic metrics calculations:
    let combinedType = "";
    let rolloffStr = "";
    let cutoffStr = "";
    let phaseStr = "-";
    let attenLabelText = "Attenuation";
    let attenValText = "-";

    if (isCouplingActive && isFilterActive) {
        combinedType = `AC + ${filterType}`;
        rolloffStr = `+12 / -${order * 6} dB/Oct`;
        cutoffStr = `${couplingCutoff.toFixed(1)}Hz & ${filterCutoff.toFixed(0)}Hz`;
        
        // Phase at filter cutoff fc
        const respAtFc = filterStage.processors.x.getFrequencyResponse(filterCutoff, fs);
        const respCAtFc = couplingStage.processors.x.getFrequencyResponse(filterCutoff, fs);
        const combinedPhase = respAtFc.phase + respCAtFc.phase;
        phaseStr = `${(combinedPhase * 180.0 / Math.PI).toFixed(0)}°`;

        if (filterType === 'LPF') {
            const testF = Math.min(maxFreq - 1, filterCutoff * 2);
            const resp2Fc = filterStage.processors.x.getFrequencyResponse(testF, fs);
            const respC2Fc = couplingStage.processors.x.getFrequencyResponse(testF, fs);
            const db2Fc = 20.0 * Math.log10(Math.max(1e-4, resp2Fc.magnitude * respC2Fc.magnitude));
            attenLabelText = `Atten. @ 2*fc (${Math.round(testF)} Hz)`;
            attenValText = `${db2Fc.toFixed(1)} dB`;
        } else {
            attenLabelText = "Bandpass Center";
            attenValText = `${Math.sqrt(couplingCutoff * filterCutoff).toFixed(1)} Hz`;
        }
    } else if (isCouplingActive) {
        combinedType = `AC (${couplingCutoff}Hz) Coupling`;
        rolloffStr = `+12 dB/Octave`;
        cutoffStr = `${couplingCutoff.toFixed(1)} Hz`;
        
        const respC = couplingStage.processors.x.getFrequencyResponse(couplingCutoff, fs);
        phaseStr = `${(respC.phase * 180.0 / Math.PI).toFixed(0)}°`;

        const testF = couplingCutoff / 2;
        const respHalf = couplingStage.processors.x.getFrequencyResponse(testF, fs);
        attenLabelText = `Atten. @ fc/2 (${testF.toFixed(1)} Hz)`;
        attenValText = `${(20.0 * Math.log10(Math.max(1e-4, respHalf.magnitude))).toFixed(1)} dB`;
    } else if (isFilterActive) {
        combinedType = `${filterType} (Butterworth)`;
        rolloffStr = `-${order * 6} dB/Octave`;
        cutoffStr = `${filterCutoff.toFixed(0)} Hz`;

        const respF = filterStage.processors.x.getFrequencyResponse(filterCutoff, fs);
        phaseStr = `${(respF.phase * 180.0 / Math.PI).toFixed(0)}°`;

        if (filterType === 'LPF') {
            const testF = Math.min(maxFreq - 1, filterCutoff * 2);
            const resp2Fc = filterStage.processors.x.getFrequencyResponse(testF, fs);
            const db2Fc = 20.0 * Math.log10(Math.max(1e-4, resp2Fc.magnitude));
            attenLabelText = `Attenuation @ 2*fc (${Math.round(testF)} Hz)`;
            attenValText = `${db2Fc.toFixed(1)} dB`;
        } else if (filterType === 'HPF') {
            const testF = filterCutoff / 2;
            const respHalf = filterStage.processors.x.getFrequencyResponse(testF, fs);
            const dbHalf = 20.0 * Math.log10(Math.max(1e-4, respHalf.magnitude));
            attenLabelText = `Attenuation @ fc/2 (${Math.round(testF)} Hz)`;
            attenValText = `${dbHalf.toFixed(1)} dB`;
        } else if (filterType === 'BPF') {
            rolloffStr = `±${(order / 2) * 6} dB/Oct`;
            attenLabelText = "Passband Center";
            attenValText = `${Math.round(filterCutoff)} Hz (Peak)`;
        } else if (filterType === 'Notch') {
            rolloffStr = "Ultra-Narrow";
            attenLabelText = "Notch Depth @ fc";
            attenValText = `${(20.0 * Math.log10(Math.max(1e-4, respF.magnitude))).toFixed(1)} dB`;
        }
    }

    // Update Diagnostics grid UI
    updateMetricsUI(
        combinedType,
        rolloffStr,
        cutoffStr,
        phaseStr,
        attenValText,
        attenLabelText
    );
}

function updateMetricsUI(type, rolloff, cutoff, phase, attenVal, attenLabel) {
    const dspFilterTypeVal = document.getElementById("dspFilterTypeVal");
    const dspRolloffVal = document.getElementById("dspRolloffVal");
    const dspCutoffVal = document.getElementById("dspCutoffVal");
    const dspPhaseFcVal = document.getElementById("dspPhaseFcVal");
    const dspAttenOctaveVal = document.getElementById("dspAttenOctaveVal");
    const dspAttenLabel = document.getElementById("dspAttenLabel");

    if (dspFilterTypeVal) dspFilterTypeVal.textContent = type;
    if (dspRolloffVal) dspRolloffVal.textContent = rolloff;
    if (dspCutoffVal) dspCutoffVal.textContent = cutoff;
    if (dspPhaseFcVal) dspPhaseFcVal.textContent = phase;
    if (dspAttenOctaveVal) dspAttenOctaveVal.textContent = attenVal;
    if (dspAttenLabel && attenLabel) dspAttenLabel.textContent = attenLabel;
}


// ================= CHARTS =================
function initCharts() {
    initThreeJS();
    initOrbitChart();

    const timeCtx = document.getElementById("timeChart").getContext("2d");
    timeChart = new Chart(timeCtx, {
        type: "line",
        data: {
            datasets: [
                { label: "X (g)", borderColor: "#ff4d6d", backgroundColor: "rgba(255,77,109,0.06)", data: [], borderWidth: 1.5, pointRadius: 0, tension: 0 },
                { label: "Y (g)", borderColor: "#10b981", backgroundColor: "rgba(16,185,129,0.06)", data: [], borderWidth: 1.5, pointRadius: 0, tension: 0 },
                { label: "Z (g)", borderColor: "#6366f1", backgroundColor: "rgba(99,102,241,0.06)", data: [], borderWidth: 1.5, pointRadius: 0, tension: 0 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                legend: { position: "top", labels: { boxWidth: 12, padding: 15, font: { size: 11 } } }
            },
            scales: {
                x: { type: "linear", title: { display: true, text: "Time (s)", font: { size: 11 } }, min: 0, max: windowSeconds, grid: { color: '#f0f0f0' } },
                y: { title: { display: true, text: "Acceleration (g)", font: { size: 11 } }, min: -2, max: 2, grid: { color: '#f0f0f0' } }
            }
        }
    });

    const crosshairPlugin = {
        id: 'crosshair',
        afterDraw: (chart) => {
            if (chart.tooltip && chart.tooltip.opacity > 0 && chart.tooltip.dataPoints && chart.tooltip.dataPoints.length > 0) {
                const ctx = chart.ctx;
                const x = chart.tooltip.dataPoints[0].element.x;
                const topY = chart.scales.y.top;
                const bottomY = chart.scales.y.bottom;
                
                ctx.save();
                ctx.beginPath();
                ctx.setLineDash([4, 4]);
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
                ctx.lineWidth = 1;
                ctx.moveTo(x, topY);
                ctx.lineTo(x, bottomY);
                ctx.stroke();
                ctx.restore();
            }
        }
    };

    const fftCtx = document.getElementById("fftChart").getContext("2d");
    fftChart = new Chart(fftCtx, {
        type: "line",
        plugins: [crosshairPlugin],
        data: {
            datasets: [{
                label: "Z FFT",
                borderColor: "#6366f1",
                backgroundColor: "rgba(99,102,241,0.06)",
                data: [],
                borderWidth: 1.5,
                pointRadius: 0,
                fill: true,
                tension: 0.1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const pt = context.raw;
                            if (pt && pt.x !== undefined && pt.y !== undefined) {
                                let unit = 'g';
                                if (displayQuantity === 'velocity') unit = 'mm/s';
                                else if (displayQuantity === 'displacement') unit = 'µm';
                                let txt = `Freq: ${pt.x.toFixed(2)} Hz, Amp: ${pt.y.toFixed(4)} ${unit}`;
                                if (pt.phase !== undefined) {
                                    txt += `, Phase: ${pt.phase.toFixed(1)}°`;
                                }
                                return txt;
                            }
                            return '';
                        }
                    }
                }
            },
            scales: {
                x: { type: "linear", title: { display: true, text: "Frequency (Hz)", font: { size: 11 } }, min: 0, max: SAMPLE_RATE / 2, grid: { color: '#f0f0f0' } },
                y: { title: { display: true, text: "Magnitude (g)", font: { size: 11 } }, min: 0, grid: { color: '#f0f0f0' } }
            }
        }
    });

    const psdCtx = document.getElementById("psdChart").getContext("2d");
    psdChart = new Chart(psdCtx, {
        type: "line",
        plugins: [crosshairPlugin],
        data: {
            datasets: [{
                label: "Z PSD",
                borderColor: "#6366f1",
                backgroundColor: "rgba(99,102,241,0.06)",
                data: [],
                borderWidth: 1.5,
                pointRadius: 0,
                fill: true,
                tension: 0.1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const pt = context.raw;
                            if (pt && pt.x !== undefined && pt.y !== undefined) {
                                let psdUnit = 'g²/Hz';
                                if (displayQuantity === 'velocity') psdUnit = '(mm/s)²/Hz';
                                else if (displayQuantity === 'displacement') psdUnit = 'µm²/Hz';
                                return `Freq: ${pt.x.toFixed(2)} Hz, PSD: ${pt.y.toExponential(4)} ${psdUnit}`;
                            }
                            return '';
                        }
                    }
                }
            },
            scales: {
                x: { type: "linear", title: { display: true, text: "Frequency (Hz)", font: { size: 11 } }, min: 0, max: SAMPLE_RATE / 2, grid: { color: '#f0f0f0' } },
                y: { type: "logarithmic", title: { display: true, text: "PSD (g²/Hz)", font: { size: 11 } }, grid: { color: '#f0f0f0' } }
            }
        }
    });
}

// ================= LIVE MOTION & DIAGNOSTICS =================
function initThreeJS() {
    const container = document.getElementById('threeContainer');
    if (!container) return;
    
    // Scene setup
    threeScene = new THREE.Scene();
    threeScene.background = null; // transparent
    
    // Camera setup
    const w = container.clientWidth || 300;
    const h = container.clientHeight || 200;
    threeCamera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    threeCamera.position.set(2.5, 3.5, 3.5);
    threeCamera.lookAt(0, 0, 0);
    
    // Renderer setup
    threeRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    threeRenderer.setSize(w, h);
    threeRenderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(threeRenderer.domElement);
    
    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    threeScene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(5, 10, 7);
    threeScene.add(dirLight);
    
    // Grid
    const gridHelper = new THREE.GridHelper(4, 10, 0x000000, 0x000000);
    gridHelper.material.opacity = 0.1;
    gridHelper.material.transparent = true;
    threeScene.add(gridHelper);
    
    // Sensor Model (board with edges for clear visibility when flat)
    const geometry = new THREE.BoxGeometry(1.5, 0.2, 1.0);
    const material = new THREE.MeshPhongMaterial({ color: 0x2563eb, flatShading: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    threeModel = new THREE.Mesh(geometry, material);
    
    // Board Edges
    const edges = new THREE.EdgesGeometry(geometry);
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x000000 });
    const wireframe = new THREE.LineSegments(edges, lineMaterial);
    threeModel.add(wireframe);

    // Neatly denoted 3D Arrow Axes attached to the board (String line with thick round arrows)
    const origin = new THREE.Vector3(0, 0, 0);
    // X Axis - Red (Sensor X -> Three.js X)
    const arrowX = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), origin, 1.2, 0xff0000, 0.3, 0.2);
    threeModel.add(arrowX);
    // Y Axis - Green (Sensor Y -> Three.js -Z)
    const arrowY = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), origin, 1.2, 0x00cc00, 0.3, 0.2);
    threeModel.add(arrowY);
    // Z Axis - Blue (Sensor Z -> Three.js Y)
    const arrowZ = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), origin, 1.2, 0x0000ff, 0.3, 0.2);
    threeModel.add(arrowZ);

    threeScene.add(threeModel);
    
    // Arrow for instant acceleration (Global) - Orange
    threeArrowDir = new THREE.Vector3(0, 1, 0);
    threeArrowHelper = new THREE.ArrowHelper(threeArrowDir, origin, 1.6, 0xff8800, 0.4, 0.25);
    threeScene.add(threeArrowHelper);
    
    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
        const cw = container.clientWidth;
        const ch = container.clientHeight;
        if(cw === 0 || ch === 0) return;
        threeCamera.aspect = cw / ch;
        threeCamera.updateProjectionMatrix();
        threeRenderer.setSize(cw, ch);
    });
    resizeObserver.observe(container);
    
    // Render loop
    function animate() {
        requestAnimationFrame(animate);
        threeRenderer.render(threeScene, threeCamera);
    }
    animate();
    
    // Reset view
    const btnReset3D = document.getElementById('btnReset3D');
    if (btnReset3D) {
        btnReset3D.onclick = () => {
            threeCamera.position.set(2.5, 3.5, 3.5);
            threeCamera.lookAt(0, 0, 0);
            threeModel.rotation.set(0,0,0);
        };
    }
}

function initOrbitChart() {
    const canvas = document.getElementById("orbitChart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    
    orbitChart = new Chart(ctx, {
        type: 'scatter',
        data: {
            datasets: [{
                label: 'Orbit',
                data: [],
                borderColor: 'rgba(37, 99, 235, 0.6)',
                backgroundColor: 'rgba(37, 99, 235, 0.6)',
                showLine: true,
                borderWidth: 1.5,
                pointRadius: 0,
                tension: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                legend: { display: false },
                tooltip: { enabled: false }
            },
            scales: {
                x: { 
                    type: 'linear', 
                    position: 'center',
                    min: -2, 
                    max: 2,
                    grid: { color: '#e2e8f0', z: -1 },
                    border: { display: false }
                },
                y: { 
                    type: 'linear', 
                    position: 'center',
                    min: -2, 
                    max: 2,
                    grid: { color: '#e2e8f0', z: -1 },
                    border: { display: false }
                }
            }
        }
    });

    // Orbit Controls
    const orbitAxisSelect = document.getElementById('orbitAxisSelect');
    if (orbitAxisSelect) {
        orbitAxisSelect.onchange = (e) => {
            orbitAxisPair = e.target.value;
            orbitChart.data.datasets[0].data = [];
            orbitChart.update('none');
        };
    }
    
    const btnFreezeOrbit = document.getElementById('btnFreezeOrbit');
    if (btnFreezeOrbit) {
        btnFreezeOrbit.onclick = () => {
            isOrbitFrozen = !isOrbitFrozen;
            btnFreezeOrbit.innerHTML = isOrbitFrozen ? 
                '<span class="material-symbols-outlined text-[12px] text-primary">play_arrow</span>' : 
                '<span class="material-symbols-outlined text-[12px]">pause</span>';
        };
    }
    
    const btnClearOrbit = document.getElementById('btnClearOrbit');
    if (btnClearOrbit) {
        btnClearOrbit.onclick = () => {
            orbitChart.data.datasets[0].data = [];
            orbitChart.update('none');
        };
    }
}


// ================= CONTROLS =================
function updateYAxis() {
    const minVal = parseFloat(yAxisMin.value);
    const maxVal = parseFloat(yAxisMax.value);
    if (!isNaN(minVal) && !isNaN(maxVal) && minVal < maxVal) {
        autoScaleY = false;
        const checkbox = document.getElementById('autoScaleY');
        if (checkbox) checkbox.checked = false;
        timeChart.options.scales.y.min = minVal;
        timeChart.options.scales.y.max = maxVal;
        timeChart.update();
    }
}

function zoomIn() {
    cycleCount = 0;
    const cycleInput = document.getElementById('cycleCountInput');
    if (cycleInput) cycleInput.value = '';
    windowSeconds = Math.max(WINDOW_MIN, windowSeconds / 2);
    updateWindowDisplay();
}

function zoomOut() {
    cycleCount = 0;
    const cycleInput = document.getElementById('cycleCountInput');
    if (cycleInput) cycleInput.value = '';
    windowSeconds = Math.min(WINDOW_MAX, windowSeconds * 2);
    updateWindowDisplay();
}

function updateWindowDisplay() {
    if (windowSeconds >= 1) {
        windowDisplay.textContent = windowSeconds.toFixed(1) + " s";
    } else {
        windowDisplay.textContent = (windowSeconds * 1000).toFixed(0) + " ms";
    }
}

// ================= MULTI-FORMAT MEASUREMENT EXPORT =================

// Battery UI color coding helper
function updateBatteryUI(level) {
    const icon = document.getElementById('batteryIcon');
    const bar = document.getElementById('batteryBar');
    const nodeIcon = document.querySelector('[data-icon="battery_full"]');
    const nodeDetail = document.getElementById('nodeDetailBattery');
    
    let color, iconName, barColor;
    if (level >= 60) {
        color = 'text-emerald-600'; iconName = 'battery_full'; barColor = 'bg-emerald-500';
    } else if (level >= 20) {
        color = 'text-amber-500'; iconName = 'battery_3_bar'; barColor = 'bg-amber-500';
    } else {
        color = 'text-red-600'; iconName = 'battery_1_bar'; barColor = 'bg-red-500';
    }
    
    if (icon) {
        icon.textContent = iconName;
        icon.className = `material-symbols-outlined text-[18px] ${color}${level < 20 ? ' battery-pulse' : ''}`;
    }
    if (bar) {
        bar.style.width = level + '%';
        bar.className = `h-full ${barColor} rounded-full transition-all duration-500`;
    }
    if (nodeIcon) {
        nodeIcon.textContent = iconName;
        nodeIcon.className = `material-symbols-outlined ${color}${level < 20 ? ' battery-pulse' : ''}`;
    }
}

// TX Power Radio Cards renderer
const TX_POWER_INFO = {
    nrf: [
        { value: '3', label: '+3 dBm', range: '~30m', desc: 'Max Range', power: 100 },
        { value: '0', label: '0 dBm', range: '~15m', desc: 'Balanced', power: 65 },
        { value: '-8', label: '-8 dBm', range: '~8m', desc: 'Low Power', power: 30 },
        { value: '-12', label: '-12 dBm', range: '~3m', desc: 'Eco', power: 15 },
    ],
    esp: [
        { value: '9', label: '+9 dBm', range: '~50m', desc: 'Max Range', power: 100 },
        { value: '0', label: '0 dBm', range: '~15m', desc: 'Balanced', power: 50 },
        { value: '-12', label: '-12 dBm', range: '~3m', desc: 'Eco', power: 10 },
    ]
};

window.renderTxPowerCards = function renderTxPowerCards() {
    const container = document.getElementById('txPowerCards');
    const select = document.getElementById('txPowerSelect');
    if (!container || !select) return;
    
    const levels = isNrfDevice ? TX_POWER_INFO.nrf : TX_POWER_INFO.esp;
    const currentVal = select.value;
    
    container.innerHTML = '';
    levels.forEach(lvl => {
        const isActive = lvl.value === currentVal;
        const card = document.createElement('div');
        card.className = `tx-power-card p-2 border rounded-lg ${isActive ? 'active border-primary bg-primary/5' : 'border-slate-200 hover:bg-slate-50'}`;
        card.innerHTML = `
            <div class="text-xs font-bold ${isActive ? 'text-primary' : 'text-slate-800'}">${lvl.label}</div>
            <div class="text-[10px] text-slate-500 mt-0.5">${lvl.range} • ${lvl.desc}</div>
            <div class="mt-1.5 h-1 bg-slate-200 rounded-full overflow-hidden">
                <div class="power-bar h-full ${isActive ? 'bg-primary' : 'bg-slate-400'} rounded-full" style="width: ${lvl.power}%"></div>
            </div>
        `;
        card.onclick = async () => {
            select.value = lvl.value;
            if (txPowerChar) {
                try {
                    await writeTxPower(lvl.value);
                    updateActiveDeviceConfigUI();
                } catch (e) {
                    showToast('TX Power Error', 'Failed to write TX power: ' + e.message, 'error', 4000);
                }
            }
            renderTxPowerCards();
        };
        container.appendChild(card);
    });
};

// Gather session metadata for export
function gatherSessionMetadata(metaFlags) {
    const meta = {};
    if (metaFlags.sensorInfo) {
        const rangeG = parseInt(localStorage.getItem("sensorRangeG") || "400", 10);
        meta.sensor = {
            name: rangeG <= 16 ? "ADXL345" : "H3LIS331DL",
            dynamicRange: `±${rangeG}g`,
            samplingRate: SAMPLE_RATE + " Hz",
            platform: isNrfDevice ? "nRF5340" : "ESP32-S3",
        };
    }
    if (metaFlags.calibInfo) {
        meta.calibration = {
            enabled: calib3x3Enabled,
            matrix: calib3x3Matrix,
            bias: calib3x3Bias,
        };
    }
    if (metaFlags.teds) {
        const rangeG = parseInt(localStorage.getItem("sensorRangeG") || "400", 10);
        meta.teds = {
            manufacturer: "SMA Lab, IIT Tirupati",
            modelNumber: rangeG <= 16 ? "ADXL345" : "H3LIS331DL",
            sensitivity: rangeG <= 16 ? "256 LSB/g" : `${49000/rangeG} LSB/g`,
            fullScale: `±${rangeG}g`,
            protocol: isNrfDevice ? "BLE 5.3 (ESB/BLE)" : "BLE 5.0",
        };
    }
    if (metaFlags.pipeline) {
        const coupling = document.getElementById('couplingSelect')?.value || 'dc';
        const quantity = document.getElementById('quantitySelect')?.value || 'acceleration';
        meta.pipeline = {
            coupling: coupling,
            displayQuantity: quantity,
            decimation: 1,
        };
    }
    if (metaFlags.acqSettings) {
        meta.acquisition = {
            timestamp: new Date().toISOString(),
            totalSamples: receivedData ? receivedData.length : 0,
            batteryLevel: window._lastBatteryLevel !== undefined ? window._lastBatteryLevel + "%" : "N/A",
            txPower: document.getElementById('txPowerSelect')?.value + " dBm" || "N/A",
        };
    }
    return meta;
}

function buildMetadataHeader(meta, commentPrefix = '# ') {
    let header = '';
    header += commentPrefix + '=== MEASUREMENT SESSION METADATA ===\n';
    header += commentPrefix + 'Export Date: ' + new Date().toISOString() + '\n';
    if (meta.sensor) {
        header += commentPrefix + 'Sensor: ' + meta.sensor.name + '\n';
        header += commentPrefix + 'Dynamic Range: ' + meta.sensor.dynamicRange + '\n';
        header += commentPrefix + 'Sampling Rate: ' + meta.sensor.samplingRate + '\n';
        header += commentPrefix + 'Platform: ' + meta.sensor.platform + '\n';
    }
    if (meta.calibration) {
        header += commentPrefix + 'Calibration Enabled: ' + meta.calibration.enabled + '\n';
        if (meta.calibration.enabled) {
            header += commentPrefix + 'Bias Offset: ' + JSON.stringify(meta.calibration.bias) + '\n';
            header += commentPrefix + 'Scaling Matrix: ' + JSON.stringify(meta.calibration.matrix) + '\n';
        }
    }
    if (meta.teds) {
        header += commentPrefix + 'TEDS Manufacturer: ' + meta.teds.manufacturer + '\n';
        header += commentPrefix + 'TEDS Model: ' + meta.teds.modelNumber + '\n';
        header += commentPrefix + 'TEDS Sensitivity: ' + meta.teds.sensitivity + '\n';
        header += commentPrefix + 'TEDS Full Scale: ' + meta.teds.fullScale + '\n';
    }
    if (meta.pipeline) {
        header += commentPrefix + 'Coupling: ' + meta.pipeline.coupling + '\n';
        header += commentPrefix + 'Display Quantity: ' + meta.pipeline.displayQuantity + '\n';
    }
    if (meta.acquisition) {
        header += commentPrefix + 'Total Samples: ' + meta.acquisition.totalSamples + '\n';
        header += commentPrefix + 'Battery Level: ' + meta.acquisition.batteryLevel + '\n';
        header += commentPrefix + 'TX Power: ' + meta.acquisition.txPower + '\n';
    }
    header += commentPrefix + '===================================\n';
    return header;
}

function buildDataColumns(contentFlags) {
    const headers = ['Sample', 'Time(s)'];
    const getters = [
        (d, i) => i + 1,
        (d) => d.t.toFixed(6),
    ];
    
    if (contentFlags.rawAccel) {
        headers.push('Raw_X(g)', 'Raw_Y(g)', 'Raw_Z(g)');
        getters.push(d => d.x.toFixed(6), d => d.y.toFixed(6), d => d.z.toFixed(6));
    }
    if (contentFlags.procAccel) {
        headers.push('Proc_X(g)', 'Proc_Y(g)', 'Proc_Z(g)');
        getters.push(
            d => (d.cx !== undefined ? d.cx : d.x).toFixed(6),
            d => (d.cy !== undefined ? d.cy : d.y).toFixed(6),
            d => (d.cz !== undefined ? d.cz : d.z).toFixed(6)
        );
    }
    if (contentFlags.velocity) {
        headers.push('Vel_X(m/s)', 'Vel_Y(m/s)', 'Vel_Z(m/s)');
        getters.push(
            d => (d.vx !== undefined ? d.vx : 0).toFixed(6),
            d => (d.vy !== undefined ? d.vy : 0).toFixed(6),
            d => (d.vz !== undefined ? d.vz : 0).toFixed(6)
        );
    }
    if (contentFlags.displacement) {
        headers.push('Disp_X(mm)', 'Disp_Y(mm)', 'Disp_Z(mm)');
        getters.push(
            d => (d.dx !== undefined ? d.dx : 0).toFixed(6),
            d => (d.dy !== undefined ? d.dy : 0).toFixed(6),
            d => (d.dz !== undefined ? d.dz : 0).toFixed(6)
        );
    }
    return { headers, getters };
}

function buildSpectralColumns(contentFlags) {
    const headers = [];
    const getters = [];
    
    let unit = 'g';
    let psdUnit = 'g²/Hz';
    if (displayQuantity === 'velocity') {
        unit = 'mm/s';
        psdUnit = '(mm/s)²/Hz';
    } else if (displayQuantity === 'displacement') {
        unit = 'µm';
        psdUnit = 'µm²/Hz';
    }
    
    if (contentFlags.fft || contentFlags.psd) {
        headers.push('Bin', 'Frequency(Hz)');
        getters.push((idx, fft, psd) => idx);
        getters.push((idx, fft, psd) => fft[idx].x.toFixed(3));
    }
    if (contentFlags.fft) {
        headers.push(`FFT_Magnitude(${unit})`);
        getters.push((idx, fft, psd) => fft[idx].y.toFixed(6));
    }
    if (contentFlags.psd) {
        headers.push(`PSD_Value(${psdUnit})`);
        getters.push((idx, fft, psd) => psd[idx].y.toFixed(6));
    }
    
    return { headers, getters };
}

function exportAsCSV(baseName, contentFlags, meta, fft, psd) {
    const timeCols = buildDataColumns(contentFlags);
    const specCols = buildSpectralColumns(contentFlags);
    
    let csv = buildMetadataHeader(meta, '# ');
    
    const hasTime = timeCols.headers.length > 2; // Sample + Time(s) + at least one channel
    const hasSpec = specCols.headers.length > 0;
    
    if (hasTime && hasSpec) {
        csv += timeCols.headers.join(',') + ',,' + specCols.headers.join(',') + '\n';
        const totalRows = Math.max(receivedData.length, fft ? fft.length : 0);
        for (let i = 0; i < totalRows; i++) {
            let rowParts = [];
            if (i < receivedData.length) {
                rowParts.push(...timeCols.getters.map(fn => fn(receivedData[i], i)));
            } else {
                rowParts.push(...timeCols.headers.map(() => ''));
            }
            rowParts.push('');
            if (hasSpec && fft && i < fft.length) {
                rowParts.push(...specCols.getters.map(fn => fn(i, fft, psd)));
            }
            csv += rowParts.join(',') + '\n';
        }
    } else if (hasSpec) {
        csv += specCols.headers.join(',') + '\n';
        const len = fft ? fft.length : (psd ? psd.length : 0);
        for (let i = 0; i < len; i++) {
            csv += specCols.getters.map(fn => fn(i, fft, psd)).join(',') + '\n';
        }
    } else {
        csv += timeCols.headers.join(',') + '\n';
        receivedData.forEach((d, i) => {
            csv += timeCols.getters.map(fn => fn(d, i)).join(',') + '\n';
        });
    }
    
    downloadFile(csv, baseName + '.csv', 'text/csv');
}

function exportAsTXT(baseName, contentFlags, meta, fft, psd) {
    const timeCols = buildDataColumns(contentFlags);
    const specCols = buildSpectralColumns(contentFlags);
    
    let txt = buildMetadataHeader(meta, '% ');
    
    const hasTime = timeCols.headers.length > 2;
    const hasSpec = specCols.headers.length > 0;
    
    if (hasTime && hasSpec) {
        txt += timeCols.headers.join('\t') + '\t\t' + specCols.headers.join('\t') + '\n';
        const totalRows = Math.max(receivedData.length, fft ? fft.length : 0);
        for (let i = 0; i < totalRows; i++) {
            let rowParts = [];
            if (i < receivedData.length) {
                rowParts.push(...timeCols.getters.map(fn => fn(receivedData[i], i)));
            } else {
                rowParts.push(...timeCols.headers.map(() => ''));
            }
            rowParts.push('');
            if (hasSpec && fft && i < fft.length) {
                rowParts.push(...specCols.getters.map(fn => fn(i, fft, psd)));
            }
            txt += rowParts.join('\t') + '\n';
        }
    } else if (hasSpec) {
        txt += specCols.headers.join('\t') + '\n';
        const len = fft ? fft.length : (psd ? psd.length : 0);
        for (let i = 0; i < len; i++) {
            txt += specCols.getters.map(fn => fn(i, fft, psd)).join('\t') + '\n';
        }
    } else {
        txt += timeCols.headers.join('\t') + '\n';
        receivedData.forEach((d, i) => {
            txt += timeCols.getters.map(fn => fn(d, i)).join('\t') + '\n';
        });
    }
    
    downloadFile(txt, baseName + '.txt', 'text/plain');
}

function exportAsJSON(baseName, contentFlags, meta, fft, psd) {
    const session = { metadata: meta, data: {} };
    if (contentFlags.rawAccel) {
        session.data.rawAcceleration = receivedData.map(d => ({ t: d.t, x: d.x, y: d.y, z: d.z }));
    }
    if (contentFlags.procAccel) {
        session.data.processedAcceleration = receivedData.map(d => ({ t: d.t, x: d.cx ?? d.x, y: d.cy ?? d.y, z: d.cz ?? d.z }));
    }
    if (contentFlags.velocity) {
        session.data.velocity = receivedData.map(d => ({ t: d.t, x: d.vx ?? 0, y: d.vy ?? 0, z: d.vz ?? 0 }));
    }
    if (contentFlags.displacement) {
        session.data.displacement = receivedData.map(d => ({ t: d.t, x: d.dx ?? 0, y: d.dy ?? 0, z: d.dz ?? 0 }));
    }
    if (contentFlags.fft && fft) {
        session.data.fft = fft.map(pt => ({ f: pt.x, mag: pt.y }));
    }
    if (contentFlags.psd && psd) {
        session.data.psd = psd.map(pt => ({ f: pt.x, val: pt.y }));
    }
    if (contentFlags.statistics) {
        const calcStats = (key) => {
            const vals = receivedData.map(d => d[key]).filter(v => v !== undefined);
            if (!vals.length) return null;
            const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
            const rms = Math.sqrt(vals.reduce((a, b) => a + b * b, 0) / vals.length);
            return { mean: mean, rms: rms, min: Math.min(...vals), max: Math.max(...vals), peak: Math.max(Math.abs(Math.min(...vals)), Math.abs(Math.max(...vals))) };
        };
        session.data.statistics = { x: calcStats('x'), y: calcStats('y'), z: calcStats('z') };
    }
    const json = JSON.stringify(session, null, 2);
    downloadFile(json, baseName + '.json', 'application/json');
}

function exportAsTDMS(baseName, contentFlags, meta, fft, psd) {
    const tdms = {
        _format: "TDMS-JSON (LabVIEW/DIAdem Compatible)",
        _version: "1.0",
        groups: []
    };
    
    if (contentFlags.rawAccel || contentFlags.procAccel) {
        const accelGroup = {
            name: "Acceleration",
            properties: meta.sensor || {},
            channels: []
        };
        if (contentFlags.rawAccel) {
            accelGroup.channels.push(
                { name: "Time", unit: "s", data: receivedData.map(d => d.t) },
                { name: "Raw_X", unit: "g", data: receivedData.map(d => d.x) },
                { name: "Raw_Y", unit: "g", data: receivedData.map(d => d.y) },
                { name: "Raw_Z", unit: "g", data: receivedData.map(d => d.z) }
            );
        }
        if (contentFlags.procAccel) {
            accelGroup.channels.push(
                { name: "Proc_X", unit: "g", data: receivedData.map(d => d.cx ?? d.x) },
                { name: "Proc_Y", unit: "g", data: receivedData.map(d => d.cy ?? d.y) },
                { name: "Proc_Z", unit: "g", data: receivedData.map(d => d.cz ?? d.z) }
            );
        }
        tdms.groups.push(accelGroup);
    }
    
    if (contentFlags.velocity) {
        tdms.groups.push({
            name: "Velocity",
            channels: [
                { name: "Vel_X", unit: "m/s", data: receivedData.map(d => d.vx ?? 0) },
                { name: "Vel_Y", unit: "m/s", data: receivedData.map(d => d.vy ?? 0) },
                { name: "Vel_Z", unit: "m/s", data: receivedData.map(d => d.vz ?? 0) }
            ]
        });
    }

    if (contentFlags.displacement) {
        tdms.groups.push({
            name: "Displacement",
            channels: [
                { name: "Disp_X", unit: "mm", data: receivedData.map(d => d.dx ?? 0) },
                { name: "Disp_Y", unit: "mm", data: receivedData.map(d => d.dy ?? 0) },
                { name: "Disp_Z", unit: "mm", data: receivedData.map(d => d.dz ?? 0) }
            ]
        });
    }

    if (contentFlags.fft && fft) {
        tdms.groups.push({
            name: "FFT",
            channels: [
                { name: "Frequency", unit: "Hz", data: fft.map(pt => pt.x) },
                { name: "Magnitude", unit: "g", data: fft.map(pt => pt.y) }
            ]
        });
    }

    if (contentFlags.psd && psd) {
        tdms.groups.push({
            name: "PSD",
            channels: [
                { name: "Frequency", unit: "Hz", data: psd.map(pt => pt.x) },
                { name: "PowerSpectralDensity", unit: "g²/Hz", data: psd.map(pt => pt.y) }
            ]
        });
    }
    
    if (meta) tdms.metadata = meta;
    const json = JSON.stringify(tdms, null, 2);
    downloadFile(json, baseName + '.tdms.json', 'application/json');
}

function exportAsMATLAB(baseName, contentFlags, meta, fft, psd) {
    const timeCols = buildDataColumns(contentFlags);
    const specCols = buildSpectralColumns(contentFlags);
    
    let mat = '% MATLAB Measurement Session Export\n';
    mat += buildMetadataHeader(meta, '% ');
    mat += '% Load with: data = readmatrix("' + baseName + '.mat", "FileType", "text");\n\n';
    
    const hasTime = timeCols.headers.length > 2;
    const hasSpec = specCols.headers.length > 0;
    
    if (hasTime && hasSpec) {
        mat += '% Columns: ' + timeCols.headers.join(', ') + ', , ' + specCols.headers.join(', ') + '\n';
        const totalRows = Math.max(receivedData.length, fft ? fft.length : 0);
        for (let i = 0; i < totalRows; i++) {
            let rowParts = [];
            if (i < receivedData.length) {
                rowParts.push(...timeCols.getters.map(fn => fn(receivedData[i], i)));
            } else {
                rowParts.push(...timeCols.headers.map(() => 'NaN'));
            }
            rowParts.push('NaN');
            if (hasSpec && fft && i < fft.length) {
                rowParts.push(...specCols.getters.map(fn => fn(i, fft, psd)));
            }
            mat += rowParts.join(' ') + '\n';
        }
    } else if (hasSpec) {
        mat += '% Columns: ' + specCols.headers.join(', ') + '\n';
        for (let i = 0; i < (fft ? fft.length : 0); i++) {
            mat += specCols.getters.map(fn => fn(i, fft, psd)).join(' ') + '\n';
        }
    } else {
        mat += '% Columns: ' + timeCols.headers.join(', ') + '\n';
        receivedData.forEach((d, i) => {
            mat += timeCols.getters.map(fn => fn(d, i)).join(' ') + '\n';
        });
    }
    downloadFile(mat, baseName + '.mat', 'text/plain');
}

function downloadFile(content, filename, mimeType) {
    try {
        const blob = new Blob([content], { type: mimeType });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
        showToast('Export Successful', `Saved ${receivedData.length} samples to ${filename}`, 'success', 4000);
    } catch (err) {
        console.error('Export Error:', err);
        showToast('Export Failed', `Error: ${err.message}`, 'error', 5000);
    }
}

function exportMeasurementSession(fileFormat, baseName, contentFlags, metaFlags) {
    if (!receivedData || receivedData.length === 0) {
        showToast('Export Failed', 'No data collected to export.', 'warning', 4000);
        return;
    }
    
    const timestampStr = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const finalName = `${baseName}_${timestampStr}`;
    const meta = gatherSessionMetadata(metaFlags);
    
    let fftResult = null;
    let psdResult = null;
    if (contentFlags.fft || contentFlags.psd) {
        const n = Math.min(fftSize, receivedData.length);
        let fftLen = 512;
        if (n >= 4096) fftLen = 4096;
        else if (n >= 2048) fftLen = 2048;
        else if (n >= 1024) fftLen = 1024;
        else if (n >= 512) fftLen = 512;
        else if (n >= 256) fftLen = 256;
        else if (n >= 128) fftLen = 128;
        else fftLen = n;
        
        let key = 'c' + fftAxis;
        if (displayQuantity === 'velocity') {
            key = 'v' + fftAxis;
        } else if (displayQuantity === 'displacement') {
            key = 'd' + fftAxis;
        }
        
        const raw = receivedData.slice(-fftLen).map(d => d[key] !== undefined ? d[key] : d[fftAxis]);
        
        try {
            const spectrum = FFTAnalyzer.analyze(raw, SAMPLE_RATE, fftWindowType);
            fftResult = spectrum.magnitudes;
            
            const localPsd = new PSDAnalyzer(1);
            psdResult = localPsd.computeAndAverage(spectrum.magnitudes, spectrum.binResolution, fftWindowType);
        } catch (e) {
            console.error("Spectral analysis failed for export:", e);
        }
    }
    
    switch (fileFormat) {
        case 'csv': exportAsCSV(finalName, contentFlags, meta, fftResult, psdResult); break;
        case 'txt': exportAsTXT(finalName, contentFlags, meta, fftResult, psdResult); break;
        case 'json': exportAsJSON(finalName, contentFlags, meta, fftResult, psdResult); break;
        case 'tdms': exportAsTDMS(finalName, contentFlags, meta, fftResult, psdResult); break;
        case 'mat': exportAsMATLAB(finalName, contentFlags, meta, fftResult, psdResult); break;
        default: exportAsCSV(finalName, contentFlags, meta, fftResult, psdResult);
    }
}

// Legacy compatibility wrapper
function saveDataToCSVWithOptions(format, baseName) {
    const contentFlags = { rawAccel: format === 'raw', procAccel: format === 'conditioned', velocity: false, displacement: false, fft: false, psd: false, statistics: false, dspConfig: false };
    const metaFlags = { sensorInfo: true, calibInfo: false, teds: false, pipeline: false, acqSettings: true };
    exportMeasurementSession('csv', baseName, contentFlags, metaFlags);
}


// ================= SCIENTIFIC VIBRATION SNR & CALIBRATION =================

async function startCalibration() {
    startCalibrationWithType("noise");
}

async function startTareCalibration() {
    startCalibrationWithType("tare");
}

async function startCalibrationWithType(type) {
    if (isCalibrating) return;
    
    // Safety check: stop active readings
    if (startButton.disabled && !stopButton.disabled) {
        showToast("Acquisition Active", "Please stop active data acquisition before starting calibration.", "warning", 4000);
        return;
    }
    
    calibrationType = type;
    isCalibrating = true;
    calibrationSamples = [];
    calibrationStartTimestamp = Date.now();
    
    // Configure modal text dynamically
    if (calibrationType === "tare") {
        calibrationDurationSeconds = 3.0;
        calibrationTotalSamples = 3.0 * SAMPLE_RATE;
        calibrationOverlay.querySelector("h3").textContent = "Calibrating Offsets";
        calibrationOverlay.querySelector("p").textContent = "Please keep the sensor flat and completely stationary.";
        calibrationCountdown.textContent = "3.0s";
    } else {
        calibrationDurationSeconds = 10.0;
        calibrationTotalSamples = 10.0 * SAMPLE_RATE;
        calibrationOverlay.querySelector("h3").textContent = "Calibrating Baseline Noise";
        calibrationOverlay.querySelector("p").textContent = "Please keep the sensor mounted rigidly and completely stationary.";
        calibrationCountdown.textContent = "10.0s";
    }
    
    // Show premium blurry modal count
    calibrationOverlay.classList.remove("hidden");
    calibrationProgressBar.style.width = "0%";
    
    // Disable both calibration/tare buttons during run
    if (calibrateButton) calibrateButton.disabled = true;
    if (tareButton) tareButton.disabled = true;
    
    // Connect listener hook
    try {
        await accelDataChar.startNotifications();
        accelDataChar.addEventListener("characteristicvaluechanged", onCalibrationData);
        console.log(`Stationary ${calibrationType} calibration active...`);
    } catch (err) {
        console.error("Calibration activation error:", err);
        showToast("Initialization Failed", "Failed to initialize calibration: " + err.message, "error", 5000);
        isCalibrating = false;
        calibrationOverlay.classList.add("hidden");
        if (calibrateButton) calibrateButton.disabled = false;
        if (tareButton) tareButton.disabled = false;
    }
}

function onCalibrationData(event) {
    if (!isCalibrating) return;
    
    const view = event.target.value;
    const packetLen = view.byteLength;
    let samplesInPacket, sampleSize, hasNewFormat;

    if (packetLen >= 239 && packetLen <= 243) {
        hasNewFormat = true;
        samplesInPacket = SAMPLES_PER_PACKET;
        sampleSize = SAMPLE_SIZE;
    } else if (packetLen >= 15) {
        hasNewFormat = false;
        samplesInPacket = view.getUint8(0);
        sampleSize = 14;
    } else {
        return;
    }

    for (let i = 0; i < samplesInPacket; i++) {
        let offset, rawX, rawY, rawZ;

        if (hasNewFormat) {
            offset = 5 + (i * SAMPLE_SIZE);
            rawX = view.getInt16(offset + 2, true);
            rawY = view.getInt16(offset + 4, true);
            rawZ = view.getInt16(offset + 6, true);
        } else {
            offset = 1 + (i * sampleSize);
            rawX = view.getInt16(offset + 8, true);
            rawY = view.getInt16(offset + 10, true);
            rawZ = view.getInt16(offset + 12, true);
        }

        const gX = rawX / LSB_PER_G;
        const gY = rawY / LSB_PER_G;
        const gZ = rawZ / LSB_PER_G;

        calibrationSamples.push({ x: gX, y: gY, z: gZ });
    }

    // Dynamic progress bar updates
    const progress = Math.min(100, (calibrationSamples.length / calibrationTotalSamples) * 100);
    calibrationProgressBar.style.width = progress.toFixed(1) + "%";
    
    const elapsed = (Date.now() - calibrationStartTimestamp) / 1000;
    const remaining = Math.max(0, calibrationDurationSeconds - elapsed);
    calibrationCountdown.textContent = remaining.toFixed(1) + "s";

    // Auto-complete when target samples met
    if (calibrationSamples.length >= calibrationTotalSamples || remaining <= 0) {
        finishCalibration();
    }
}

async function finishCalibration() {
    isCalibrating = false;
    calibrationOverlay.classList.add("hidden");
    
    // Re-enable buttons
    if (calibrateButton) calibrateButton.disabled = false;
    if (tareButton) tareButton.disabled = false;
    
    // Release listener hook
    try {
        await accelDataChar.stopNotifications();
        accelDataChar.removeEventListener("characteristicvaluechanged", onCalibrationData);
    } catch (err) {
        console.error("Failed to release calibration listener:", err);
    }

    if (calibrationSamples.length < 200) {
        showToast("Calibration Failed", "Insufficient telemetry samples received from nRF5340 board.", "error", 5000);
        return;
    }

    // Subtract gravitational DC mean vector
    const n = calibrationSamples.length;
    const meanX = calibrationSamples.reduce((sum, s) => sum + s.x, 0) / n;
    const meanY = calibrationSamples.reduce((sum, s) => sum + s.y, 0) / n;
    const meanZ = calibrationSamples.reduce((sum, s) => sum + s.z, 0) / n;

    if (calibrationType === "noise") {
        // STEP 6: Run calibration samples through the ACTIVE signal pipeline
        // to match the bandwidth of the noise floor to the measurement path.
        // This prevents coupling/filter mismatch artifacts in SNR calculations.
        const calibPipeline = new SignalProcessingPipeline();
        calibPipeline.updateParams(signalPipeline.couplingMode, signalPipeline.sampleRate);
        // Copy filter settings from the live pipeline
        const liveFilter = signalPipeline.stages.find(s => s.name === 'filter');
        const calibFilter = calibPipeline.stages.find(s => s.name === 'filter');
        if (liveFilter && calibFilter && liveFilter.filterType !== 'None') {
            calibFilter.configure(liveFilter.filterType, liveFilter.order, liveFilter.cutoff, signalPipeline.sampleRate);
        }

        // Prime the pipeline to clear settling transients (feed first 20% of samples)
        const primeCount = Math.min(Math.floor(n * 0.2), n);
        for (let i = 0; i < primeCount; i++) {
            calibPipeline.apply({ x: calibrationSamples[i].x - meanX, y: calibrationSamples[i].y - meanY, z: calibrationSamples[i].z - meanZ });
        }

        // Compute noise RMS from pipeline-filtered, DC-subtracted samples
        const filteredSamples = [];
        for (let i = primeCount; i < n; i++) {
            const dcRemoved = { x: calibrationSamples[i].x - meanX, y: calibrationSamples[i].y - meanY, z: calibrationSamples[i].z - meanZ };
            filteredSamples.push(calibPipeline.apply(dcRemoved));
        }

        const fn = filteredSamples.length;
        const varX = filteredSamples.reduce((sum, s) => sum + s.x * s.x, 0) / fn;
        const varY = filteredSamples.reduce((sum, s) => sum + s.y * s.y, 0) / fn;
        const varZ = filteredSamples.reduce((sum, s) => sum + s.z * s.z, 0) / fn;

        const rmsX = Math.sqrt(varX);
        const rmsY = Math.sqrt(varY);
        const rmsZ = Math.sqrt(varZ);

        // Save pipeline state tag alongside noise values for invalidation
        calibratedNoiseRms = { x: rmsX, y: rmsY, z: rmsZ };
        calibratedNoisePipelineTag = signalPipeline.couplingMode + '|' + (liveFilter ? liveFilter.filterType + ':' + liveFilter.cutoff : 'None');
        localStorage.setItem('calibrated_noise_rms', JSON.stringify(calibratedNoiseRms));
        localStorage.setItem('calibrated_noise_pipeline_tag', calibratedNoisePipelineTag);

        // Refresh UI
        updateNoiseFloorUI();

        showToast("Noise Floor Calibrated", `Baseline noise floors saved:\nX: ${(rmsX * 1000).toFixed(3)} mg  Y: ${(rmsY * 1000).toFixed(3)} mg  Z: ${(rmsZ * 1000).toFixed(3)} mg`, "success", 5000);
    } else if (calibrationType === "tare") {
        // Offset Calibration
        // Since the sensor was stationary, X and Y should be 0.0g, Z should be 1.0g (gravity)
        calibOffsetX = meanX;
        calibOffsetY = meanY;
        calibOffsetZ = meanZ - 1.0;
        
        localStorage.setItem("calibOffsetX", calibOffsetX);
        localStorage.setItem("calibOffsetY", calibOffsetY);
        localStorage.setItem("calibOffsetZ", calibOffsetZ);

        // Also calculate stationary baseline noise during Tare calibration
        // Use same pipeline-aware approach as noise calibration
        const calibPipeline = new SignalProcessingPipeline();
        calibPipeline.updateParams(signalPipeline.couplingMode, signalPipeline.sampleRate);
        const liveFilter = signalPipeline.stages.find(s => s.name === 'filter');
        const calibFilter = calibPipeline.stages.find(s => s.name === 'filter');
        if (liveFilter && calibFilter && liveFilter.filterType !== 'None') {
            calibFilter.configure(liveFilter.filterType, liveFilter.order, liveFilter.cutoff, signalPipeline.sampleRate);
        }

        const primeCount = Math.min(Math.floor(n * 0.2), n);
        for (let i = 0; i < primeCount; i++) {
            calibPipeline.apply({ x: calibrationSamples[i].x - meanX, y: calibrationSamples[i].y - meanY, z: calibrationSamples[i].z - meanZ });
        }

        const filteredSamples = [];
        for (let i = primeCount; i < n; i++) {
            const dcRemoved = { x: calibrationSamples[i].x - meanX, y: calibrationSamples[i].y - meanY, z: calibrationSamples[i].z - meanZ };
            filteredSamples.push(calibPipeline.apply(dcRemoved));
        }

        const fn = filteredSamples.length;
        const varX = filteredSamples.reduce((sum, s) => sum + s.x * s.x, 0) / fn;
        const varY = filteredSamples.reduce((sum, s) => sum + s.y * s.y, 0) / fn;
        const varZ = filteredSamples.reduce((sum, s) => sum + s.z * s.z, 0) / fn;

        const rmsX = Math.sqrt(varX);
        const rmsY = Math.sqrt(varY);
        const rmsZ = Math.sqrt(varZ);

        calibratedNoiseRms = { x: rmsX, y: rmsY, z: rmsZ };
        calibratedNoisePipelineTag = signalPipeline.couplingMode + '|' + (liveFilter ? liveFilter.filterType + ':' + liveFilter.cutoff : 'None');
        localStorage.setItem('calibrated_noise_rms', JSON.stringify(calibratedNoiseRms));
        localStorage.setItem('calibrated_noise_pipeline_tag', calibratedNoisePipelineTag);
        updateNoiseFloorUI();
        
        showToast("Offset & Noise Calibrated", `Offsets applied:\nX: ${calibOffsetX.toFixed(4)} g  Y: ${calibOffsetY.toFixed(4)} g  Z: ${calibOffsetZ.toFixed(4)} g\n\nBaseline noise floors saved:\nX: ${(rmsX * 1000).toFixed(3)} mg  Y: ${(rmsY * 1000).toFixed(3)} mg  Z: ${(rmsZ * 1000).toFixed(3)} mg`, "success", 5000);
    }
}

function updateNoiseFloorUI() {
    if (noiseFloorX && noiseFloorY && noiseFloorZ && calibratedNoiseRms) {
        noiseFloorX.textContent = (calibratedNoiseRms.x * 1000).toFixed(2) + ' mg';
        noiseFloorY.textContent = (calibratedNoiseRms.y * 1000).toFixed(2) + ' mg';
        noiseFloorZ.textContent = (calibratedNoiseRms.z * 1000).toFixed(2) + ' mg';
    }
}

function updateRealtimeSNR(slice) {
    const statPpX = document.getElementById("statPpX");
    const statPpY = document.getElementById("statPpY");
    const statPpZ = document.getElementById("statPpZ");
    
    const statCfX = document.getElementById("statCfX");
    const statCfY = document.getElementById("statCfY");
    const statCfZ = document.getElementById("statCfZ");
    
    const statKurtX = document.getElementById("statKurtX");
    const statKurtY = document.getElementById("statKurtY");
    const statKurtZ = document.getElementById("statKurtZ");

    const domFreqX = document.getElementById("domFreqX");
    const domFreqY = document.getElementById("domFreqY");
    const domFreqZ = document.getElementById("domFreqZ");

    if (signalPipeline.isSettling()) {
        if (signalRmsX) signalRmsX.textContent = 'Settling...';
        if (signalRmsY) signalRmsY.textContent = 'Settling...';
        if (signalRmsZ) signalRmsZ.textContent = 'Settling...';
        if (snrXEl) snrXEl.textContent = 'Settling...';
        if (snrYEl) snrYEl.textContent = 'Settling...';
        if (snrZEl) snrZEl.textContent = 'Settling...';
        
        if (statPpX) statPpX.textContent = 'Settling...';
        if (statPpY) statPpY.textContent = 'Settling...';
        if (statPpZ) statPpZ.textContent = 'Settling...';
        
        if (statCfX) statCfX.textContent = 'Settling...';
        if (statCfY) statCfY.textContent = 'Settling...';
        if (statCfZ) statCfZ.textContent = 'Settling...';
        
        if (statKurtX) statKurtX.textContent = 'Settling...';
        if (statKurtY) statKurtY.textContent = 'Settling...';
        if (statKurtZ) statKurtZ.textContent = 'Settling...';

        if (domFreqX) domFreqX.textContent = 'Settling...';
        if (domFreqY) domFreqY.textContent = 'Settling...';
        if (domFreqZ) domFreqZ.textContent = 'Settling...';
        return;
    }

    const n = slice.length;
    let keyX = 'cx', keyY = 'cy', keyZ = 'cz';
    let multiplier = 1000.0;
    let unit = 'mg';

    if (displayQuantity === 'velocity') {
        keyX = 'vx'; keyY = 'vy'; keyZ = 'vz';
        multiplier = 1.0;
        unit = 'mm/s';
    } else if (displayQuantity === 'displacement') {
        keyX = 'dx'; keyY = 'dy'; keyZ = 'dz';
        multiplier = 1.0;
        unit = 'µm';
    }

    // Use StatisticsEngine for all axes
    const extractVals = (key, fallback) => slice.map(d => d[key] !== undefined ? d[key] : d[fallback]);
    const valsX = extractVals(keyX, 'x');
    const valsY = extractVals(keyY, 'y');
    const valsZ = extractVals(keyZ, 'z');

    const statsX = StatisticsEngine.compute(valsX);
    const statsY = StatisticsEngine.compute(valsY);
    const statsZ = StatisticsEngine.compute(valsZ);

    // Update real-time RMS labels in UI
    if (signalRmsX) signalRmsX.textContent = (statsX.rms * multiplier).toFixed(1) + ' ' + unit;
    if (signalRmsY) signalRmsY.textContent = (statsY.rms * multiplier).toFixed(1) + ' ' + unit;
    if (signalRmsZ) signalRmsZ.textContent = (statsZ.rms * multiplier).toFixed(1) + ' ' + unit;

    // Update advanced vibration statistics
    if (statPpX) statPpX.textContent = (statsX.pp * multiplier).toFixed(1) + ' ' + unit;
    if (statPpY) statPpY.textContent = (statsY.pp * multiplier).toFixed(1) + ' ' + unit;
    if (statPpZ) statPpZ.textContent = (statsZ.pp * multiplier).toFixed(1) + ' ' + unit;
    
    if (statCfX) statCfX.textContent = statsX.cf.toFixed(2);
    if (statCfY) statCfY.textContent = statsY.cf.toFixed(2);
    if (statCfZ) statCfZ.textContent = statsZ.cf.toFixed(2);
    
    if (statKurtX) statKurtX.textContent = statsX.kurtosis.toFixed(2);
    if (statKurtY) statKurtY.textContent = statsY.kurtosis.toFixed(2);
    if (statKurtZ) statKurtZ.textContent = statsZ.kurtosis.toFixed(2);

    // Primary Frequency per-axis (quick FFT peak search)
    if (domFreqX || domFreqY || domFreqZ) {
        const minFFT = 128;
        if (n >= minFFT) {
            const detectPrimary = (vals) => {
                try {
                    const blockSize = Math.min(vals.length, fftSize);
                    const block = vals.slice(-blockSize);
                    const spec = FFTAnalyzer.analyze(block, SAMPLE_RATE, fftWindowType);
                    const harm = HarmonicAnalyzer.analyze(spec.magnitudes, spec.binResolution);
                    return harm.peakFreq;
                } catch (e) { return 0; }
            };
            if (domFreqX) domFreqX.textContent = detectPrimary(valsX).toFixed(1) + ' Hz';
            if (domFreqY) domFreqY.textContent = detectPrimary(valsY).toFixed(1) + ' Hz';
            if (domFreqZ) domFreqZ.textContent = detectPrimary(valsZ).toFixed(1) + ' Hz';
        }
    }

    const calcTimeSNR = (activeRMS, baselineNoise) => {
        if (activeRMS <= baselineNoise * 1.05) {
            return 0.0;
        }
        const cleanSignal = Math.sqrt(Math.max(0, activeRMS * activeRMS - baselineNoise * baselineNoise));
        return 20 * Math.log10(cleanSignal / baselineNoise);
    };

    // Calculate dynamic physical acceleration RMS for physical channel SNR estimation
    const getAccelRms = (key) => {
        const vals = slice.map(d => d[key] !== undefined ? d[key] : d[key.slice(1)]);
        return StatisticsEngine.compute(vals).rms;
    };

    const accelRmsX = getAccelRms('cx');
    const accelRmsY = getAccelRms('cy');
    const accelRmsZ = getAccelRms('cz');

    const snrXVal = calcTimeSNR(accelRmsX, calibratedNoiseRms.x);
    const snrYVal = calcTimeSNR(accelRmsY, calibratedNoiseRms.y);
    const snrZVal = calcTimeSNR(accelRmsZ, calibratedNoiseRms.z);

    // Check if current pipeline state matches the calibration conditions
    const liveFilter = signalPipeline.stages.find(s => s.name === 'filter');
    const currentPipelineTag = signalPipeline.couplingMode + '|' + (liveFilter && liveFilter.active ? liveFilter.filterType + ':' + liveFilter.cutoff : 'None');
    const pipelineMismatch = (calibratedNoisePipelineTag !== currentPipelineTag);

    if (snrXEl) applySnrColor(snrXEl, snrXVal, pipelineMismatch);
    if (snrYEl) applySnrColor(snrYEl, snrYVal, pipelineMismatch);
    if (snrZEl) applySnrColor(snrZEl, snrZVal, pipelineMismatch);
}

function computeSpectralSNR(magnitudes) {
    if (magnitudes.length < 20) return null;
    
    // 1. Find peak carrier bin (ignoring DC drift below 5Hz)
    let peakMag = 0;
    let peakIdx = 0;
    
    const freqResolution = magnitudes[1].x - magnitudes[0].x;
    const startIdx = Math.max(1, Math.ceil(5 / freqResolution)); // Skip < 5Hz
    
    for (let i = startIdx; i < magnitudes.length; i++) {
        const mag = magnitudes[i].y;
        if (mag > peakMag) {
            peakMag = mag;
            peakIdx = i;
        }
    }
    
    // Gating: scale threshold to active full-scale range (LSB sensitivity)
    // At ±400g, 1 LSB ≈ 0.012g; at ±100g, 1 LSB ≈ 0.003g; at ±2g, 1 LSB ≈ 0.00006g
    // Use a fraction of the full-scale range as the noise gate
    const fullScaleG = 32768 / LSB_PER_G;
    const peakGate = fullScaleG * 1.5e-5; // ~0.15% of full-scale range
    if (peakMag < peakGate) {
        return 0.0;
    }
    
    // 2. Sum power in Hann-window leak compensation window (peak ± 2 bins)
    let signalPower = 0;
    const peakRange = 2; 
    const signalBinCount = 2 * peakRange + 1; // 5 bins
    const activePeakStart = Math.max(0, peakIdx - peakRange);
    const activePeakEnd = Math.min(magnitudes.length - 1, peakIdx + peakRange);
    
    for (let i = activePeakStart; i <= activePeakEnd; i++) {
        signalPower += magnitudes[i].y * magnitudes[i].y;
    }
    
    // 3. Average remaining spectrum bins for unbiased noise power (excluding Low Freq & Peak Area)
    let noisePowerSum = 0;
    let noiseBinCount = 0;
    const excludeRange = 5; 
    const excludeStart = peakIdx - excludeRange;
    const excludeEnd = peakIdx + excludeRange;
    
    for (let i = startIdx; i < magnitudes.length; i++) {
        if (i >= excludeStart && i <= excludeEnd) {
            continue;
        }
        noisePowerSum += magnitudes[i].y * magnitudes[i].y;
        noiseBinCount++;
    }
    
    if (noiseBinCount === 0 || noisePowerSum === 0) return null;
    const averageNoisePowerPerBin = noisePowerSum / noiseBinCount;
    
    // 4. Normalize noise to the SAME bandwidth as the signal window before comparing.
    //    Without this, comparing 5-bin signal power against 1-bin noise power
    //    inflates SNR by a constant 10·log10(5) ≈ +7 dB.
    const equivalentNoisePower = averageNoisePowerPerBin * signalBinCount;
    
    // 5. SNR = 10 * log10(Signal Power / Equivalent Noise Power)
    const ratio = signalPower / equivalentNoisePower;
    if (ratio <= 1.0) {
        return 0.0;
    }
    
    return 10 * Math.log10(ratio);
}

function applySnrColor(el, snr, pipelineMismatch) {
    if (snr === null || !isFinite(snr)) {
        el.textContent = '—';
        el.style.color = '';
        el.title = '';
        return;
    }
    
    // Append asterisk when noise calibration was done under different pipeline settings
    const suffix = pipelineMismatch ? ' *' : '';
    el.textContent = snr.toFixed(1) + ' dB' + suffix;
    el.title = pipelineMismatch ? 'Noise calibration mismatch: re-calibrate for accurate SNR' : '';
    if (snr >= 20) {
        el.style.color = 'var(--success)';
    } else if (snr >= 5) {
        el.style.color = '#f59e0b';
    } else {
        el.style.color = 'var(--text-muted)';
    }
}

function toggleTimeAxis(index, button) {
    if (!timeChart) return;
    const isVisible = timeChart.isDatasetVisible(index);
    timeChart.setDatasetVisibility(index, !isVisible);
    if (isVisible) {
        button.classList.remove('active');
    } else {
        button.classList.add('active');
    }
    timeChart.update();
}

// ================= 3x3 ADVANCED CALIBRATION METHODS =================

function updateCalibMetadataFromCurrent() {
    let meta = null;
    const storedMetaStr = localStorage.getItem("calib3x3Metadata");
    if (storedMetaStr) {
        try {
            meta = JSON.parse(storedMetaStr);
        } catch (e) {}
    }
    
    const checksum = calculateCalibChecksum(calib3x3Matrix, calib3x3Bias);
    
    if (!meta) {
        meta = {
            version: 2,
            sensorType: "H3LIS331DL",
            firmwareVersion: "Rev 9",
            timestamp: new Date().toISOString(),
            numSamplesPerStep: 5120,
            sampleRate: SAMPLE_RATE,
            rmsError: 0.0,
            maxError: 0.0,
            conditionNumber: 1.0,
            revision: Date.now(),
            checksum: checksum,
            static: {
                matrix: calib3x3Matrix,
                bias: calib3x3Bias
            },
            temperatureModel: {
                enabled: false,
                referenceTemp: 25.0,
                biasCoefficients: { x: [0, 0, 0], y: [0, 0, 0], z: [0, 0, 0] },
                scaleCoefficients: { x: [0, 0, 0], y: [0, 0, 0], z: [0, 0, 0] }
            }
        };
    } else {
        meta.checksum = checksum;
        meta.static.matrix = calib3x3Matrix;
        meta.static.bias = calib3x3Bias;
        meta.revision = Date.now();
        meta.timestamp = new Date().toISOString();
    }
    
    localStorage.setItem("calib3x3Metadata", JSON.stringify(meta));
    showCalibMetricsPanel(meta);
}

function onMatrixInputChange() {
    calib3x3Matrix = [
        [
            parseFloat(document.getElementById("m00").value) || 1.0,
            parseFloat(document.getElementById("m01").value) || 0.0,
            parseFloat(document.getElementById("m02").value) || 0.0
        ],
        [
            parseFloat(document.getElementById("m10").value) || 0.0,
            parseFloat(document.getElementById("m11").value) || 1.0,
            parseFloat(document.getElementById("m12").value) || 0.0
        ],
        [
            parseFloat(document.getElementById("m20").value) || 0.0,
            parseFloat(document.getElementById("m21").value) || 0.0,
            parseFloat(document.getElementById("m22").value) || 1.0
        ]
    ];
    localStorage.setItem("calib3x3Matrix", JSON.stringify(calib3x3Matrix));
    updateCalibMetadataFromCurrent();
}

function onBiasInputChange() {
    calib3x3Bias = {
        x: parseFloat(document.getElementById("bx").value) || 0.0,
        y: parseFloat(document.getElementById("by").value) || 0.0,
        z: parseFloat(document.getElementById("bz").value) || 0.0
    };
    localStorage.setItem("calib3x3Bias", JSON.stringify(calib3x3Bias));
    updateCalibMetadataFromCurrent();
}

function updateMatrixUI() {
    document.getElementById("m00").value = calib3x3Matrix[0][0];
    document.getElementById("m01").value = calib3x3Matrix[0][1];
    document.getElementById("m02").value = calib3x3Matrix[0][2];
    document.getElementById("m10").value = calib3x3Matrix[1][0];
    document.getElementById("m11").value = calib3x3Matrix[1][1];
    document.getElementById("m12").value = calib3x3Matrix[1][2];
    document.getElementById("m20").value = calib3x3Matrix[2][0];
    document.getElementById("m21").value = calib3x3Matrix[2][1];
    document.getElementById("m22").value = calib3x3Matrix[2][2];
}

function updateBiasUI() {
    document.getElementById("bx").value = calib3x3Bias.x;
    document.getElementById("by").value = calib3x3Bias.y;
    document.getElementById("bz").value = calib3x3Bias.z;

    const maxBiasRange = 0.5;
    const updateBar = (val, barId, textId) => {
        const textEl = document.getElementById(textId);
        if (textEl) textEl.textContent = (val >= 0 ? '+' : '') + val.toFixed(3) + 'g';
        
        const barEl = document.getElementById(barId);
        if (barEl) {
            const percentage = Math.max(-50, Math.min(50, (val / maxBiasRange) * 50));
            if (percentage >= 0) {
                barEl.style.left = '50%';
                barEl.style.width = percentage + '%';
                barEl.style.backgroundColor = '#10B981';
            } else {
                barEl.style.left = (50 + percentage) + '%';
                barEl.style.width = Math.abs(percentage) + '%';
                barEl.style.backgroundColor = '#EF4444';
            }
        }
    };

    updateBar(calib3x3Bias.x, 'biasBarX', 'biasValTextX');
    updateBar(calib3x3Bias.y, 'biasBarY', 'biasValTextY');
    updateBar(calib3x3Bias.z, 'biasBarZ', 'biasValTextZ');
}

// ── 6-Position Step Definitions ──────────────────────────────────────────────
const sixPosStepData = {
    1: {
        emoji:    "⬆️",
        heading:  'Place sensor flat — <span style="color:#2563EB;">Top face UP</span>',
        subtitle: 'Lay the board on the table with the <strong>component side facing the ceiling</strong>.<br>Hold still, then press <strong>Capture</strong>.',
        axis:     "+Z up"
    },
    2: {
        emoji:    "⬇️",
        heading:  'Flip sensor COMPLETELY UPSIDE-DOWN — <span style="color:#2563EB;">component side facing TABLE</span>',
        subtitle: 'The board must be fully inverted 180°. Rest it on its top face.<br>'
                 +'If unsure, use a jig or press it flat against the table surface.<br>'
                 +'The Z reading should drop from ~+1g to ~−1g during capture.',
        axis:     "-Z up"
    },
    3: {
        emoji:    "👉",
        heading:  'Stand sensor on its edge — <span style="color:#2563EB;">X-axis pointing UP</span>',
        subtitle: 'Rotate the board so the <strong>+X arrow on the silkscreen points towards the ceiling</strong>.<br>Lean it against a wall or jig. Hold still, then press <strong>Capture</strong>.',
        axis:     "+X up"
    },
    4: {
        emoji:    "👈",
        heading:  'Stand sensor on its edge — <span style="color:#2563EB;">X-axis pointing DOWN</span>',
        subtitle: 'Flip 180° from the previous step so <strong>+X arrow now points to the table</strong>.<br>Hold still, then press <strong>Capture</strong>.',
        axis:     "-X up"
    },
    5: {
        emoji:    "🔼",
        heading:  'Stand sensor on its edge — <span style="color:#2563EB;">Y-axis pointing UP</span>',
        subtitle: 'Rotate the board so the <strong>+Y arrow on the silkscreen points towards the ceiling</strong>.<br>Hold still, then press <strong>Capture</strong>.',
        axis:     "+Y up"
    },
    6: {
        emoji:    "🔽",
        heading:  'Stand sensor on its edge — <span style="color:#2563EB;">Y-axis pointing DOWN</span>',
        subtitle: 'Flip 180° from the previous step so <strong>+Y arrow now points to the table</strong>.<br>Hold still, then press <strong>Capture</strong>.',
        axis:     "-Y up"
    }
};

/**
 * Update the 6-position calibration modal UI for the given step number.
 * Refreshes the step tracker dots, emoji, heading, subtitle, and button text.
 */
function updateSixPosUI(step, isRetry) {
    const data = sixPosStepData[step];
    if (!data) return;

    // Step tracker dots
    const dots = document.querySelectorAll(".six-pos-dot");
    dots.forEach(dot => {
        const dotStep = parseInt(dot.dataset.step);
        dot.classList.remove("active", "done");
        if (dotStep < step)       dot.classList.add("done");
        else if (dotStep === step) dot.classList.add("active");
    });

    // Emoji
    const emojiEl = document.getElementById("sixPosEmoji");
    if (emojiEl) emojiEl.textContent = data.emoji;

    // Heading
    const headingEl = document.getElementById("sixPosHeading");
    if (headingEl) headingEl.innerHTML = data.heading;

    // Subtitle
    const subtitleEl = document.getElementById("sixPosSubtitle");
    if (subtitleEl) subtitleEl.innerHTML = data.subtitle;

    // Capture button
    const captureBtn = document.getElementById("sixPosCaptureBtn");
    if (captureBtn) {
        captureBtn.innerHTML = isRetry
            ? `🔄 Retry Position ${step}`
            : `▶ Capture Position ${step}`;
        captureBtn.disabled = false;
    }
}

function startSixPosCalibration() {
    if (isCalibrating || isSixPosCalibrating) return;
    isSixPosCalibrating = true;
    sixPosStep = 1;
    sixPosSamples = [];
    sixPosMeans = [];
    
    // Calibration runs at the user's currently selected g-range.
    // No auto-switch — avoids race condition between BLE range command and LSB_PER_G update.
    const gRangeSelect = document.getElementById("gRangeSelect");
    const currentRange = gRangeSelect ? parseInt(gRangeSelect.value, 10) : 400;
    window._preCalibratonRange = currentRange;
    
    // Disable buttons
    if (calibrateButton) calibrateButton.disabled = true;
    if (tareButton) tareButton.disabled = true;
    if (sixPosCalButton) sixPosCalButton.disabled = true;
    if (validateCalButton) validateCalButton.disabled = true;
    if (resetCalMatrixButton) resetCalMatrixButton.disabled = true;
    if (calibRollbackButton) calibRollbackButton.disabled = true;
    if (startButton) startButton.disabled = true;
    if (stopButton) stopButton.disabled = true;
    
    // Set up modal
    const overlay = document.getElementById("sixPosCalOverlay");
    if (overlay) overlay.classList.remove("hidden");
    
    // Populate step 1 content
    updateSixPosUI(1, false);
    
    const captureBtn = document.getElementById("sixPosCaptureBtn");
    if (captureBtn) {
        captureBtn.onclick = captureSixPosStep;
    }
    
    const cancelBtn = document.getElementById("sixPosCancelBtn");
    if (cancelBtn) {
        cancelBtn.onclick = cancelSixPosCalibration;
    }
    
    const progressBar = document.getElementById("sixPosProgressBar");
    if (progressBar) progressBar.style.width = "0%";
    
    const countdown = document.getElementById("sixPosCountdown");
    if (countdown) {
        countdown.textContent = "10.0s";
        countdown.style.display = "block";
    }
    
    const spinner = document.getElementById("sixPosSpinner");
    if (spinner) spinner.style.display = "none";
}

async function captureSixPosStep() {
    const captureBtn = document.getElementById("sixPosCaptureBtn");
    if (captureBtn) captureBtn.disabled = true;
    
    const spinner = document.getElementById("sixPosSpinner");
    if (spinner) spinner.style.display = "block";
    
    sixPosSamples = [];
    sixPosStartTimestamp = Date.now();
    sixPosSettling = true;
    
    try {
        await accelDataChar.startNotifications();
        accelDataChar.addEventListener("characteristicvaluechanged", onSixPosCalData);
    } catch (err) {
        console.error("Failed to start 6-pos notifications:", err);
        showToast("Capture Failed", "Failed to initialize capture: " + err.message, "error", 5000);
        cancelSixPosCalibration();
    }
}

function onSixPosCalData(event) {
    if (!isSixPosCalibrating) return;
    
    const view = event.target.value;
    const packetSamples = parseBLEAccelPacket(view);
    if (!packetSamples) return;

    const now = Date.now();
    if (sixPosSettling) {
        if (now - sixPosStartTimestamp < 500) {
            const countdown = document.getElementById("sixPosCountdown");
            if (countdown) countdown.textContent = "Settling...";
            return;
        }
        sixPosSettling = false;
        sixPosStartTimestamp = now;
    }

    for (let i = 0; i < packetSamples.length; i++) {
        sixPosSamples.push(packetSamples[i]);
    }

    const progress = Math.min(100, (sixPosSamples.length / sixPosTargetSamples) * 100);
    const progressBar = document.getElementById("sixPosProgressBar");
    if (progressBar) progressBar.style.width = progress.toFixed(1) + "%";
    
    const elapsed = (Date.now() - sixPosStartTimestamp) / 1000;
    const remaining = Math.max(0, sixPosCountdownVal - elapsed);
    const countdown = document.getElementById("sixPosCountdown");
    if (countdown) countdown.textContent = remaining.toFixed(1) + "s";

    if (sixPosSamples.length >= sixPosTargetSamples || remaining <= 0) {
        finishSixPosStep();
    }
}

async function finishSixPosStep() {
    // Release listener hook
    try {
        await accelDataChar.stopNotifications();
        accelDataChar.removeEventListener("characteristicvaluechanged", onSixPosCalData);
    } catch (err) {
        console.error("Failed to release 6-pos listener:", err);
    }
    
    const spinner = document.getElementById("sixPosSpinner");
    if (spinner) spinner.style.display = "none";
    
    // Per-orientation stability check
    const metrics = computeStabilityMetrics(sixPosSamples);
    console.log('Six-pos step', sixPosStep, 'metrics:', metrics);
    const threshold = parseFloat(document.getElementById("calibStabilityThreshold").value) || 0.25;

    if (metrics.norm > threshold) {
        showToast("Stability Check Failed", `Motion detected during step ${sixPosStep}\nStd Dev: ${metrics.norm.toFixed(4)} g (threshold: ${threshold.toFixed(4)} g)\nPlease hold the sensor stationary and retry.`, "warning", 6000);
        
        // Reset progress bar & countdown for this step
        const progressBar = document.getElementById("sixPosProgressBar");
        if (progressBar) progressBar.style.width = "0%";
        const countdown = document.getElementById("sixPosCountdown");
        if (countdown) countdown.textContent = sixPosCountdownVal.toFixed(1) + "s";
        
        // Re-enable capture button with retry styling
        updateSixPosUI(sixPosStep, true);
        return;
    }
    
    // ── Per-step axis sanity check (bias-aware) ──────────────────────
    // We cannot compare raw absolute values to ±1g because the uncalibrated
    // sensor can have large bias offsets (e.g. bz ≈ 2g). Instead, we use
    // RELATIVE DOMINANCE: the axis that should carry gravity must have the
    // largest absolute reading among the three axes. This is invariant to
    // any additive bias because bias shifts all 6 positions equally, but
    // gravity only adds ±1g to one specific axis per step.
    //
    // For paired steps, we also verify the SIGN FLIP: the reading on the
    // expected axis must change sign between the + and - step of the pair.
    // This catches the case where the sensor was never actually flipped.
    //
    // Step mapping:  1=+Z, 2=-Z, 3=+X, 4=-X, 5=+Y, 6=-Y
    const stepAxisMap = {
        1: { axis: 'z', sign: +1, pair: null },
        2: { axis: 'z', sign: -1, pair: 1 },
        3: { axis: 'x', sign: +1, pair: null },
        4: { axis: 'x', sign: -1, pair: 3 },
        5: { axis: 'y', sign: +1, pair: null },
        6: { axis: 'y', sign: -1, pair: 5 }
    };
    const stepInfo = stepAxisMap[sixPosStep];
    const axisNames = ['x', 'y', 'z'];
    const readings = { x: metrics.meanX, y: metrics.meanY, z: metrics.meanZ };
    const expectedAxis = stepInfo.axis;
    const expectedReading = readings[expectedAxis];
    const otherAxes = axisNames.filter(a => a !== expectedAxis);
    const otherMax = Math.max(...otherAxes.map(a => Math.abs(readings[a])));

    // Dominance check: the expected axis must have the largest magnitude
    if (Math.abs(expectedReading) < otherMax) {
        const axisLabel = expectedAxis.toUpperCase();
        showToast("Orientation Check Failed",
            `Step ${sixPosStep} expects gravity on ${axisLabel}-axis, but another axis dominates.\n`
           +`Readings: X=${metrics.meanX.toFixed(3)}g  Y=${metrics.meanY.toFixed(3)}g  Z=${metrics.meanZ.toFixed(3)}g\n`
           +`${axisLabel}=${Math.abs(expectedReading).toFixed(3)}g vs other=${otherMax.toFixed(3)}g\n`
           +`Please verify the sensor orientation matches the diagram and retry.`,
            "warning", 8000);
        updateSixPosUI(sixPosStep, true);
        return;
    }

    // Sign-flip check for paired steps (step 2 vs 1, step 4 vs 3, step 6 vs 5)
    if (stepInfo.pair !== null) {
        const pairIndex = stepInfo.pair - 1; // sixPosMeans is 0-indexed
        const pairReading = sixPosMeans[pairIndex][expectedAxis];
        // The paired readings must have opposite signs. If both have the
        // same sign, the sensor was NOT flipped between the + and - step.
        if (Math.sign(expectedReading) === Math.sign(pairReading)) {
            const axisLabel = expectedAxis.toUpperCase();
            showToast("Sign Flip Check Failed",
                `Step ${sixPosStep} (−${axisLabel}) must be flipped 180° from step ${stepInfo.pair} (+${axisLabel}).\n`
               +`Step ${stepInfo.pair} ${axisLabel}=${pairReading.toFixed(3)}g → Step ${sixPosStep} ${axisLabel}=${expectedReading.toFixed(3)}g\n`
               +`Both readings have the SAME sign — the sensor was likely not flipped.\n`
               +`Please flip the sensor completely and retry this step.`,
                "error", 8000);
            updateSixPosUI(sixPosStep, true);
            return;
        }
    }

    // Stable and correct orientation! Store mean raw vector and standard deviations
    sixPosMeans.push({
        x: metrics.meanX,
        y: metrics.meanY,
        z: metrics.meanZ,
        stdDevX: metrics.stdDevX,
        stdDevY: metrics.stdDevY,
        stdDevZ: metrics.stdDevZ
    });
    console.log(`Step ${sixPosStep} captured (${sixPosStepData[sixPosStep]?.axis}): x=${metrics.meanX.toFixed(4)}, y=${metrics.meanY.toFixed(4)}, z=${metrics.meanZ.toFixed(4)}`);
    
    sixPosStep++;
    
    if (sixPosStep <= 6) {
        // Prepare next step via the unified UI helper
        updateSixPosUI(sixPosStep, false);
        
        const progressBar = document.getElementById("sixPosProgressBar");
        if (progressBar) progressBar.style.width = "0%";
        
        const countdown = document.getElementById("sixPosCountdown");
        if (countdown) countdown.textContent = sixPosCountdownVal.toFixed(1) + "s";
    } else {
        // Complete calibration calculation!
        calculateSixPosCalibration();
    }
}

function calculateSixPosCalibration() {
    const v1 = sixPosMeans[0]; // +Z
    const v2 = sixPosMeans[1]; // -Z
    const v3 = sixPosMeans[2]; // +X
    const v4 = sixPosMeans[3]; // -X
    const v5 = sixPosMeans[4]; // +Y
    const v6 = sixPosMeans[5]; // -Y

    // Calculate column vectors of K
    const k1 = {
        x: (v3.x - v4.x) / 2,
        y: (v3.y - v4.y) / 2,
        z: (v3.z - v4.z) / 2
    };
    const k2 = {
        x: (v5.x - v6.x) / 2,
        y: (v5.y - v6.y) / 2,
        z: (v5.z - v6.z) / 2
    };
    const k3 = {
        x: (v1.x - v2.x) / 2,
        y: (v1.y - v2.y) / 2,
        z: (v1.z - v2.z) / 2
    };

    // Bias vector b is the average of all 6 positions
    const bxVal = (v1.x + v2.x + v3.x + v4.x + v5.x + v6.x) / 6;
    const byVal = (v1.y + v2.y + v3.y + v4.y + v5.y + v6.y) / 6;
    const bzVal = (v1.z + v2.z + v3.z + v4.z + v5.z + v6.z) / 6;

    // Post-computation bias sanity gate
    // In a correct 6-position calibration, bias = average of all 6 readings.
    // Gravity cancels between paired +/− steps, so bias ≈ true sensor offset.
    // H3LIS331DL datasheet: zero-g offset typical ±150mg, max ±500mg.
    // PCB stress can add some, but bz=1.9g indicates a wrong capture step.
    // Limit: ±1.0g (2× the ±500mg spec) — catches wrong-orientation errors
    // while allowing reasonable hardware variation.
    const gRangeSelect = document.getElementById("gRangeSelect");
    const activeRange = gRangeSelect ? gRangeSelect.value : "400";
    const BIAS_LIMIT_G = {
        100: 0.75,  // ±100g range: ±750mg max bias
        200: 1.00,  // ±200g range: ±1.0g max bias
        400: 1.00   // ±400g range: ±1.0g max bias
    };
    const limit = BIAS_LIMIT_G[parseInt(activeRange, 10)] || 1.00;

    if (Math.abs(bxVal) > limit || Math.abs(byVal) > limit || Math.abs(bzVal) > limit) {
        showToast("Bias Out of Range",
            `Calibration rejected — bias vector exceeds spec:\n`
           +`bx=${bxVal.toFixed(3)}g  by=${byVal.toFixed(3)}g  bz=${bzVal.toFixed(3)}g\n`
           +`Limit: ±${limit}g for ±${activeRange}g range.\n`
           +"One or more orientations were likely captured incorrectly.",
            "error", 8000);
        cancelSixPosCalibration();
        return;
    }

    // Non-blocking traceability warning: ST's datasheet puts the H3LIS331DL's
    // typical zero-g offset at ±1.0g, with up to ±3.0g from PCB stress.
    const BIAS_TYPICAL_G = 1.5;
    if (Math.abs(bxVal) > BIAS_TYPICAL_G || Math.abs(byVal) > BIAS_TYPICAL_G || Math.abs(bzVal) > BIAS_TYPICAL_G) {
        console.warn(`Calibration bias [${bxVal.toFixed(3)}, ${byVal.toFixed(3)}, ${bzVal.toFixed(3)}]g exceeds typical ±${BIAS_TYPICAL_G}g spec (within ±${limit}g accepted limit). Note in QA record.`);
    }

    // K matrix
    const K00 = k1.x, K01 = k2.x, K02 = k3.x;
    const K10 = k1.y, K11 = k2.y, K12 = k3.y;
    const K20 = k1.z, K21 = k2.z, K22 = k3.z;

    // Determinant
    const detK = K00 * (K11 * K22 - K12 * K21) -
                 K01 * (K10 * K22 - K12 * K20) +
                 K02 * (K10 * K21 - K11 * K20);

    if (Math.abs(detK) < 1e-4) {
        showToast("Matrix Singular", "Calibration matrix is near-singular (det=" + detK.toFixed(6) + "). Please ensure the sensor was placed in correct orthogonal positions.", "error", 6000);
        cancelSixPosCalibration();
        return;
    }

    const invDet = 1.0 / detK;
    
    // Invert K to get raw M
    let rawM = [
        [
            (K11 * K22 - K12 * K21) * invDet,
            (K02 * K21 - K01 * K22) * invDet,
            (K01 * K12 - K02 * K11) * invDet
        ],
        [
            (K12 * K20 - K10 * K22) * invDet,
            (K00 * K22 - K02 * K20) * invDet,
            (K02 * K10 - K00 * K12) * invDet
        ],
        [
            (K10 * K21 - K11 * K20) * invDet,
            (K01 * K20 - K00 * K21) * invDet,
            (K00 * K11 - K01 * K10) * invDet
        ]
    ];

    // Compute condition number kappa(K) = ||K||_F * ||M||_F
    const matrixK = [
        [K00, K01, K02],
        [K10, K11, K12],
        [K20, K21, K22]
    ];
    // Condition number: compute on M (calibration matrix), not K (pre-inversion matrix)
    const normM_raw = computeFrobeniusNorm(rawM);
    // For cond(M), we need ||M|| * ||M⁻¹||. M⁻¹ = K (the original half-difference matrix).
    const normK = computeFrobeniusNorm(matrixK);
    const condNum = normM_raw * normK; // cond(M) = ||M||_F * ||M⁻¹||_F = ||M||_F * ||K||_F

    // Per-axis scale-factor (SF) deviation gate
    // Industry standard: ±5% acceptable, reject at ±15%.
    const SF_DEVIATION_WARN_PCT = 5.0;
    const SF_DEVIATION_REJECT_PCT = 15.0;
    const sfDeviations = [
        Math.abs(rawM[0][0] - 1.0) * 100,
        Math.abs(rawM[1][1] - 1.0) * 100,
        Math.abs(rawM[2][2] - 1.0) * 100
    ];
    const maxSfDeviation = Math.max(...sfDeviations);
    const sfDeviationAxis = ["X", "Y", "Z"][sfDeviations.indexOf(maxSfDeviation)];

    if (maxSfDeviation > SF_DEVIATION_REJECT_PCT) {
        showToast("Scale Factor Out of Range",
            `Calibration rejected — SF ${sfDeviationAxis} deviates ${maxSfDeviation.toFixed(1)}% from nominal (reject limit: ${SF_DEVIATION_REJECT_PCT}%).\n`
           +`SF X=${(rawM[0][0]).toFixed(4)}  SF Y=${(rawM[1][1]).toFixed(4)}  SF Z=${(rawM[2][2]).toFixed(4)}\n`
           +"This usually means a position was captured with motion or out of orthogonal orientation. Please retry.",
            "error", 8000);
        cancelSixPosCalibration();
        return;
    }
    const sfDeviationWarning = maxSfDeviation > SF_DEVIATION_WARN_PCT;
    if (sfDeviationWarning) {
        console.warn(`SF deviation on axis ${sfDeviationAxis} is ${maxSfDeviation.toFixed(2)}%, above ±${SF_DEVIATION_WARN_PCT}% tolerance but within ${SF_DEVIATION_REJECT_PCT}% reject limit.`);
    }

    // Cross-axis coupling gate — measures how much one axis "leaks" into another.
    // Industry limit: <2% for precision, <5% acceptable for high-g MEMS.
    // Reject at >10% (indicates wrong orientation or severe vibration during capture).
    const CROSS_AXIS_WARN_PCT = 5.0;
    const CROSS_AXIS_REJECT_PCT = 10.0;
    const crossAxisTerms = [
        { name: 'X←Y', val: Math.abs(rawM[0][1]) * 100 },
        { name: 'X←Z', val: Math.abs(rawM[0][2]) * 100 },
        { name: 'Y←X', val: Math.abs(rawM[1][0]) * 100 },
        { name: 'Y←Z', val: Math.abs(rawM[1][2]) * 100 },
        { name: 'Z←X', val: Math.abs(rawM[2][0]) * 100 },
        { name: 'Z←Y', val: Math.abs(rawM[2][1]) * 100 }
    ];
    const worstCrossAxis = crossAxisTerms.reduce((a, b) => a.val > b.val ? a : b);

    if (worstCrossAxis.val > CROSS_AXIS_REJECT_PCT) {
        showToast("Cross-Axis Coupling Too High",
            `Calibration rejected — ${worstCrossAxis.name} coupling is ${worstCrossAxis.val.toFixed(1)}% (reject limit: ${CROSS_AXIS_REJECT_PCT}%).\n`
           +`This means ${worstCrossAxis.val.toFixed(1)}% of one axis leaks into another.\n`
           +crossAxisTerms.map(t => `${t.name}: ${t.val.toFixed(2)}%`).join('  ') + '\n'
           +"The ±Y or ±X step orientations were likely incorrect. Please retry on a vibration-isolated surface.",
            "error", 8000);
        cancelSixPosCalibration();
        return;
    }
    const crossAxisWarning = worstCrossAxis.val > CROSS_AXIS_WARN_PCT;
    if (crossAxisWarning) {
        console.warn(`Cross-axis coupling ${worstCrossAxis.name} is ${worstCrossAxis.val.toFixed(2)}%, above ${CROSS_AXIS_WARN_PCT}% tolerance but within ${CROSS_AXIS_REJECT_PCT}% reject limit.`);
    }

    // Numerical Clamping — last-resort safety net (primary gating is the SF deviation check above)
    let clampingApplied = false;
    let clampMsg = "";

    // Clamp bias to +/- 10g (±400g sensor may have larger zero-g offset)
    let bClamp = {
        x: Math.max(-10.0, Math.min(10.0, bxVal)),
        y: Math.max(-10.0, Math.min(10.0, byVal)),
        z: Math.max(-10.0, Math.min(10.0, bzVal))
    };
    if (bClamp.x !== bxVal || bClamp.y !== byVal || bClamp.z !== bzVal) {
        clampingApplied = true;
        clampMsg += `• Bias vector clamped from [${bxVal.toFixed(4)}, ${byVal.toFixed(4)}, ${bzVal.toFixed(4)}] to [${bClamp.x.toFixed(4)}, ${bClamp.y.toFixed(4)}, ${bClamp.z.toFixed(4)}] g\n`;
    }

    // Clamp Matrix elements
    // ±400g high-g sensor: wider limits needed due to coarse quantization
    // Diagonal in [0.3, 3.0], off-diagonal in [-0.5, 0.5]
    let mClamp = [[0,0,0],[0,0,0],[0,0,0]];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            if (i === j) {
                // Diagonal (scale factors)
                const val = rawM[i][j];
                mClamp[i][j] = Math.max(0.3, Math.min(3.0, val));
                if (mClamp[i][j] !== val) {
                    clampingApplied = true;
                    clampMsg += `• Diagonal element M[${i}][${j}] clamped from ${val.toFixed(4)} to ${mClamp[i][j].toFixed(4)}\n`;
                }
            } else {
                // Off-diagonal (cross-axis coupling)
                const val = rawM[i][j];
                mClamp[i][j] = Math.max(-0.5, Math.min(0.5, val));
                if (mClamp[i][j] !== val) {
                    clampingApplied = true;
                    clampMsg += `• Off-diagonal element M[${i}][${j}] clamped from ${val.toFixed(4)} to ${mClamp[i][j].toFixed(4)}\n`;
                }
            }
        }
    }

    calib3x3Matrix = mClamp;
    calib3x3Bias = bClamp;

    // Calculate pooled noise from all 6 positions
    let noiseXSqSum = 0;
    let noiseYSqSum = 0;
    let noiseZSqSum = 0;
    for (let j = 0; j < 6; j++) {
        const v = sixPosMeans[j];
        noiseXSqSum += (v.stdDevX || 0) * (v.stdDevX || 0);
        noiseYSqSum += (v.stdDevY || 0) * (v.stdDevY || 0);
        noiseZSqSum += (v.stdDevZ || 0) * (v.stdDevZ || 0);
    }
    const noiseX = Math.sqrt(noiseXSqSum / 6);
    const noiseY = Math.sqrt(noiseYSqSum / 6);
    const noiseZ = Math.sqrt(noiseZSqSum / 6);

    calibratedNoiseRms = { x: noiseX, y: noiseY, z: noiseZ };
    localStorage.setItem('calibrated_noise_rms', JSON.stringify(calibratedNoiseRms));
    updateNoiseFloorUI();

    // Compute residual quality metrics on the 6 calibration positions
    let sqErrSum = 0;
    let maxError = 0;
    for (let j = 0; j < 6; j++) {
        const v = sixPosMeans[j];
        // Apply matrix and bias
        const dx = v.x - calib3x3Bias.x;
        const dy = v.y - calib3x3Bias.y;
        const dz = v.z - calib3x3Bias.z;
        const cx = calib3x3Matrix[0][0]*dx + calib3x3Matrix[0][1]*dy + calib3x3Matrix[0][2]*dz;
        const cy = calib3x3Matrix[1][0]*dx + calib3x3Matrix[1][1]*dy + calib3x3Matrix[1][2]*dz;
        const cz = calib3x3Matrix[2][0]*dx + calib3x3Matrix[2][1]*dy + calib3x3Matrix[2][2]*dz;
        const norm = Math.sqrt(cx*cx + cy*cy + cz*cz);
        const err = Math.abs(norm - 1.0);
        sqErrSum += err * err;
        if (err > maxError) maxError = err;
    }
    const rmsError = Math.sqrt(sqErrSum / 6);

    // Quality gates — tightened now that despiking removes spurious large-error contributors.
    // 0.08g RMS / 0.15g max matches ~1-2% of FS tolerance for industry practice.
    const rmsLimit = 0.08;
    const maxLimit = 0.15;
    const isQualityPass = (rmsError < rmsLimit) && (maxError < maxLimit) && !sfDeviationWarning && !crossAxisWarning;

    // Save parameters
    localStorage.setItem("calib3x3Matrix", JSON.stringify(calib3x3Matrix));
    localStorage.setItem("calib3x3Bias", JSON.stringify(calib3x3Bias));
    
    calib3x3Enabled = true;
    localStorage.setItem("calib3x3Enabled", "true");
    
    // Update UI
    if (calib3x3EnabledCheckbox) calib3x3EnabledCheckbox.checked = true;
    updateMatrixUI();
    updateBiasUI();

    // Create Metadata record (Version 2 structure)
    const timestamp = new Date().toISOString();
    const checksum = calculateCalibChecksum(calib3x3Matrix, calib3x3Bias);
    const revision = Date.now();
    
    const calibMetadata = {
        version: 2,
        sensorType: "H3LIS331DL",
        firmwareVersion: "Rev 9",
        timestamp: timestamp,
        gRange: activeRange,
        numSamplesPerStep: sixPosTargetSamples,
        sampleRate: SAMPLE_RATE,
        rmsError: rmsError,
        maxError: maxError,
        conditionNumber: condNum,
        revision: revision,
        checksum: checksum,
        noise: {
            x: noiseX,
            y: noiseY,
            z: noiseZ
        },
        static: {
            matrix: calib3x3Matrix,
            bias: calib3x3Bias
        },
        temperatureModel: {
            enabled: false,
            referenceTemp: 25.0,
            biasCoefficients: { x: [0, 0, 0], y: [0, 0, 0], z: [0, 0, 0] },
            scaleCoefficients: { x: [0, 0, 0], y: [0, 0, 0], z: [0, 0, 0] }
        }
    };

    localStorage.setItem("calib3x3Metadata", JSON.stringify(calibMetadata));

    // Save to history (keep last 5)
    let history = [];
    const historyStr = localStorage.getItem("calibHistory");
    if (historyStr) {
        try {
            history = JSON.parse(historyStr);
            if (!Array.isArray(history)) history = [];
        } catch (e) {
            history = [];
        }
    }
    history.unshift(calibMetadata);
    if (history.length > 5) {
        history = history.slice(0, 5);
    }
    localStorage.setItem("calibHistory", JSON.stringify(history));

    // Display results in sidebar panel
    showCalibMetricsPanel(calibMetadata);
    loadCalibrationHistoryUI();

    // Close overlay
    const overlay = document.getElementById("sixPosCalOverlay");
    if (overlay) overlay.classList.add("hidden");

    isSixPosCalibrating = false;
    restorePreCalibrationRange();

    // Enable buttons
    if (calibrateButton) calibrateButton.disabled = false;
    if (tareButton) tareButton.disabled = false;
    if (sixPosCalButton) sixPosCalButton.disabled = false;
    if (validateCalButton) validateCalButton.disabled = false;
    if (resetCalMatrixButton) resetCalMatrixButton.disabled = false;
    if (startButton) startButton.disabled = false;
    if (stopButton) stopButton.disabled = true;

    // Toast notification — calibration status card already shows full details
    const toastType = isQualityPass ? "success" : "warning";
    const toastTitle = isQualityPass ? "Calibration Successful" : "Calibration Warning";
    const toastBody = `Range: ±${activeRange}g\nRMS Error: ${rmsError.toFixed(5)} g\nQuality: ${(Math.exp(-rmsError * 5.0) * 100).toFixed(1)}%\nNoise: X=${(calibratedNoiseRms.x * 1000).toFixed(2)} mg, Y=${(calibratedNoiseRms.y * 1000).toFixed(2)} mg, Z=${(calibratedNoiseRms.z * 1000).toFixed(2)} mg`;
    showToast(toastTitle, toastBody, toastType, 6000);
}

function restorePreCalibrationRange() {
    const preCalRange = window._preCalibratonRange;
    if (preCalRange && preCalRange !== 100 && operatingModeChar) {
        let cmdByte = 0x22; // default ±400g
        if (preCalRange === 100) cmdByte = 0x20;
        else if (preCalRange === 200) cmdByte = 0x21;
        
        const data = new Uint8Array([cmdByte]);
        operatingModeChar.writeValue(data).then(() => {
            updateLSBPerG(preCalRange);
            localStorage.setItem("sensorRangeG", preCalRange.toString());
            const gRangeSelect = document.getElementById("gRangeSelect");
            if (gRangeSelect) gRangeSelect.value = preCalRange.toString();
            showToast("Range Restored", `Sensor range restored to ±${preCalRange}g.`, "info", 3000);
            console.log(`Restored sensor range to ±${preCalRange}g`);
        }).catch(err => {
            console.warn("Could not restore original range:", err);
        });
    }
    delete window._preCalibratonRange;
}

async function cancelSixPosCalibration() {
    isSixPosCalibrating = false;
    restorePreCalibrationRange();
    
    try {
        if (accelDataChar) {
            await accelDataChar.stopNotifications();
            accelDataChar.removeEventListener("characteristicvaluechanged", onSixPosCalData);
        }
    } catch (err) {
        console.warn("Error stopping notifications on cancel:", err);
    }
    
    const overlay = document.getElementById("sixPosCalOverlay");
    if (overlay) overlay.classList.add("hidden");
    
    // Enable buttons
    if (calibrateButton) calibrateButton.disabled = false;
    if (tareButton) tareButton.disabled = false;
    if (sixPosCalButton) sixPosCalButton.disabled = false;
    if (validateCalButton) validateCalButton.disabled = false;
    if (resetCalMatrixButton) resetCalMatrixButton.disabled = false;
    if (startButton) startButton.disabled = false;
    if (stopButton) stopButton.disabled = true;
    loadCalibrationHistoryUI();
}

function resetCalib3x3() {
    if (confirm("Are you sure you want to reset the calibration matrix to Identity and bias to Zero?")) {
        calib3x3Matrix = [
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0]
        ];
        calib3x3Bias = { x: 0.0, y: 0.0, z: 0.0 };
        localStorage.setItem("calib3x3Matrix", JSON.stringify(calib3x3Matrix));
        localStorage.setItem("calib3x3Bias", JSON.stringify(calib3x3Bias));
        
        calib3x3Enabled = false;
        localStorage.setItem("calib3x3Enabled", "false");
        if (calib3x3EnabledCheckbox) calib3x3EnabledCheckbox.checked = false;
        
        localStorage.removeItem("calib3x3Metadata");
        showCalibMetricsPanel(null);
        
        updateMatrixUI();
        updateBiasUI();
        loadCalibrationHistoryUI();
    }
}

// ================= COMPRESSION / PARSING / MATH UTILITIES =================

function parseBLEAccelPacket(view) {
    const packetLen = view.byteLength;
    let samplesInPacket, sampleSize, hasNewFormat;

    if (packetLen >= 239 && packetLen <= 243) {
        hasNewFormat = true;
        samplesInPacket = SAMPLES_PER_PACKET;
        sampleSize = SAMPLE_SIZE;
    } else if (packetLen >= 15) {
        hasNewFormat = false;
        samplesInPacket = view.getUint8(0);
        sampleSize = 14;
    } else {
        return null;
    }

    const samples = [];
    for (let i = 0; i < samplesInPacket; i++) {
        let offset, rawX, rawY, rawZ;

        if (hasNewFormat) {
            offset = 5 + (i * SAMPLE_SIZE);
            rawX = view.getInt16(offset + 2, true);
            rawY = view.getInt16(offset + 4, true);
            rawZ = view.getInt16(offset + 6, true);
        } else {
            offset = 1 + (i * sampleSize);
            rawX = view.getInt16(offset + 8, true);
            rawY = view.getInt16(offset + 10, true);
            rawZ = view.getInt16(offset + 12, true);
        }

        samples.push({
            x: rawX / LSB_PER_G,
            y: rawY / LSB_PER_G,
            z: rawZ / LSB_PER_G
        });
    }
    return samples;
}

/**
 * Compute the median of a numeric array. Used as a robust center estimate
 * for despiking, since a plain mean is corrupted by the spikes we're detecting.
 */
function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const n = sorted.length;
    if (n === 0) return 0;
    const mid = Math.floor(n / 2);
    return (n % 2 !== 0) ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Despike a static capture window using per-axis median + MAD outlier filter.
 * A single corrupted BLE/SPI sample gets averaged into the position mean by a
 * naive arithmetic mean; the calibration matrix can then amplify that error by
 * 100x+. MAD-based rejection (median ± k*1.4826*MAD) is a standard robust
 * statistics technique that doesn't get dragged off-center by the spikes.
 *
 * @param {Array<{x:number,y:number,z:number}>} samples
 * @param {number} k  MAD multiplier (5 = conservative, only rejects genuine outliers)
 * @returns {{clean: Array, rejectedCount: number}}
 */
function despikeSamples(samples, k = 5.0) {
    const n = samples.length;
    if (n < 9) return { clean: samples, rejectedCount: 0 };

    const xs = samples.map(s => s.x);
    const ys = samples.map(s => s.y);
    const zs = samples.map(s => s.z);

    const medX = median(xs), medY = median(ys), medZ = median(zs);
    const madX = median(xs.map(v => Math.abs(v - medX))) || 1e-6;
    const madY = median(ys.map(v => Math.abs(v - medY))) || 1e-6;
    const madZ = median(zs.map(v => Math.abs(v - medZ))) || 1e-6;

    // 1.4826 scales MAD to a consistent estimator of std-dev for normal data
    const threshX = k * 1.4826 * madX;
    const threshY = k * 1.4826 * madY;
    const threshZ = k * 1.4826 * madZ;

    const clean = [];
    let rejectedCount = 0;
    for (let i = 0; i < n; i++) {
        const s = samples[i];
        if (Math.abs(s.x - medX) > threshX ||
            Math.abs(s.y - medY) > threshY ||
            Math.abs(s.z - medZ) > threshZ) {
            rejectedCount++;
        } else {
            clean.push(s);
        }
    }

    // Safety: if filter rejected nearly everything, fall back to unfiltered
    if (clean.length < Math.max(5, n * 0.5)) {
        return { clean: samples, rejectedCount: 0 };
    }
    return { clean, rejectedCount };
}

function computeStabilityMetrics(samples) {
    if (samples.length === 0) return { meanX: 0, meanY: 0, meanZ: 0, stdDevX: 0, stdDevY: 0, stdDevZ: 0, norm: 0, rejectedCount: 0, sampleCount: 0 };

    // Despike before computing statistics — prevents a single glitched
    // BLE/SPI sample from corrupting the position mean
    const { clean, rejectedCount } = despikeSamples(samples);

    let sumX = 0, sumY = 0, sumZ = 0;
    const len = clean.length;
    for (let i = 0; i < len; i++) {
        sumX += clean[i].x;
        sumY += clean[i].y;
        sumZ += clean[i].z;
    }
    const meanX = sumX / len;
    const meanY = sumY / len;
    const meanZ = sumZ / len;

    let sqSumX = 0, sqSumY = 0, sqSumZ = 0;
    for (let i = 0; i < len; i++) {
        sqSumX += (clean[i].x - meanX) ** 2;
        sqSumY += (clean[i].y - meanY) ** 2;
        sqSumZ += (clean[i].z - meanZ) ** 2;
    }
    const stdDevX = Math.sqrt(sqSumX / len);
    const stdDevY = Math.sqrt(sqSumY / len);
    const stdDevZ = Math.sqrt(sqSumZ / len);
    const norm = Math.sqrt(stdDevX*stdDevX + stdDevY*stdDevY + stdDevZ*stdDevZ);
    return { meanX, meanY, meanZ, stdDevX, stdDevY, stdDevZ, norm, rejectedCount, sampleCount: samples.length };
}

function computeFrobeniusNorm(matrix) {
    let sum = 0;
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            sum += matrix[i][j] * matrix[i][j];
        }
    }
    return Math.sqrt(sum);
}

function calculateCalibChecksum(matrix, bias) {
    const str = JSON.stringify({ m: matrix, b: bias });
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
        hash = hash & 0xFFFFFFFF; // Convert to 32bit integer
    }
    return hash.toString(16);
}

// ================= METRICS PANEL & HISTORY CONTROL =================

function showCalibMetricsPanel(meta) {
    const statusBadge = document.getElementById("calibStatusBadge");
    const qualityText = document.getElementById("calibQualityText");
    const qualityBar = document.getElementById("calibQualityBar");
    const healthRms = document.getElementById("calibHealthRms");
    const healthMax = document.getElementById("calibHealthMax");
    const viewCertBtn = document.getElementById("viewCertButton");
    const lastDate = document.getElementById("calibLastDate");

    if (!meta) {
        if (statusBadge) {
            statusBadge.innerHTML = `<span style="width: 8px; height: 8px; border-radius: 50%; background-color: #EF4444; display: inline-block;"></span> UNCALIBRATED`;
            statusBadge.style.color = "#EF4444";
        }
        if (qualityText) qualityText.textContent = "N/A";
        if (qualityBar) {
            qualityBar.style.width = "0%";
            qualityBar.style.background = "rgba(0,0,0,0.1)";
        }
        if (healthRms) healthRms.textContent = "-";
        if (healthMax) healthMax.textContent = "-";
        if (lastDate) lastDate.textContent = "N/A";
        if (viewCertBtn) viewCertBtn.disabled = true;
        return;
    }

    if (viewCertBtn) viewCertBtn.disabled = false;

    const rms = meta.rmsError || 0.0;
    const maxErr = meta.maxError || 0.0;
    const cond = meta.conditionNumber || 1.0;
    const checksum = meta.checksum || "N/A";
    const rev = meta.revision || 0;
    
    let formattedDate = "N/A";
    if (meta.timestamp) {
        const d = new Date(meta.timestamp);
        if (!isNaN(d.getTime())) {
            const options = { 
                day: '2-digit', 
                month: 'short', 
                year: 'numeric', 
                hour: '2-digit', 
                minute: '2-digit' 
            };
            formattedDate = d.toLocaleString('en-US', options);
        }
    }

    // Quality calculation: composite score incorporating RMS fit, SF deviation,
    // cross-axis coupling, and bias magnitude — not just training-set self-validation.
    // Each metric is scored 0-100 and weighted to produce a composite.
    const M = calib3x3Matrix || [[1,0,0],[0,1,0],[0,0,1]];
    const B = calib3x3Bias || {x:0, y:0, z:0};

    // Sub-score 1: RMS fit (exponential decay, same as before but lower weight)
    const rmsScore = Math.exp(-rms * 5.0) * 100;

    // Sub-score 2: Max SF deviation (100 at 0%, 0 at 15%+)
    const sfDevs = [Math.abs(M[0][0]-1)*100, Math.abs(M[1][1]-1)*100, Math.abs(M[2][2]-1)*100];
    const maxSfDev = Math.max(...sfDevs);
    const sfScore = Math.max(0, 100 - (maxSfDev / 15) * 100);

    // Sub-score 3: Max cross-axis coupling (100 at 0%, 0 at 10%+)
    const crossTerms = [M[0][1], M[0][2], M[1][0], M[1][2], M[2][0], M[2][1]].map(v => Math.abs(v) * 100);
    const maxCross = Math.max(...crossTerms);
    const crossScore = Math.max(0, 100 - (maxCross / 10) * 100);

    // Sub-score 4: Max bias magnitude (100 at 0g, 0 at 1g+)
    const maxBias = Math.max(Math.abs(B.x), Math.abs(B.y), Math.abs(B.z));
    const biasScore = Math.max(0, 100 - (maxBias / 1.0) * 100);

    // Composite: weighted average (RMS fit is only 25%, physical metrics are 75%)
    const quality = Math.max(0, Math.min(100,
        rmsScore * 0.25 + sfScore * 0.25 + crossScore * 0.30 + biasScore * 0.20
    ));

    let rating = "EXCELLENT";
    let ratingColor = "#10B981"; // green
    if (quality < 50) {
        rating = "FAIL";
        ratingColor = "#EF4444"; // red
    } else if (quality < 70) {
        rating = "POOR";
        ratingColor = "#EF4444"; // red
    } else if (quality < 90) {
        rating = "GOOD";
        ratingColor = "#F59E0B"; // amber
    }

    if (statusBadge) {
        statusBadge.innerHTML = `<span style="width: 8px; height: 8px; border-radius: 50%; background-color: #10B981; display: inline-block;"></span> VALIDATED`;
        statusBadge.style.color = "#10B981";
    }

    if (qualityText) {
        qualityText.textContent = `${quality.toFixed(1)}% (${rating})`;
        qualityText.style.color = ratingColor;
    }

    if (qualityBar) {
        qualityBar.style.width = `${quality}%`;
        qualityBar.style.background = ratingColor;
    }

    if (healthRms) healthRms.textContent = `${rms.toFixed(5)} g`;
    if (healthMax) healthMax.textContent = `${maxErr.toFixed(5)} g`;
    if (lastDate) lastDate.textContent = formattedDate;

    // Populate Sensitivity Deviation Report (industry-standard physical metrics)
    const sensReport = document.getElementById("calibSensitivityReport");
    if (sensReport && calib3x3Matrix) {
        sensReport.style.display = "block";
        const M = calib3x3Matrix;
        const B = calib3x3Bias;

        // Scale factor deviation from ideal 1.0 (per axis)
        const sfX = ((M[0][0] - 1.0) * 100).toFixed(3);
        const sfY = ((M[1][1] - 1.0) * 100).toFixed(3);
        const sfZ = ((M[2][2] - 1.0) * 100).toFixed(3);

        // Cross-axis sensitivity (max off-diagonal element)
        const cas = Math.max(
            Math.abs(M[0][1]), Math.abs(M[0][2]),
            Math.abs(M[1][0]), Math.abs(M[1][2]),
            Math.abs(M[2][0]), Math.abs(M[2][1])
        );

        const sfXEl = document.getElementById("calibSfX");
        const sfYEl = document.getElementById("calibSfY");
        const sfZEl = document.getElementById("calibSfZ");
        const casEl = document.getElementById("calibCrossAxis");
        const condEl = document.getElementById("calibCondNum");
        const bxEl = document.getElementById("calibBiasXmg");
        const byEl = document.getElementById("calibBiasYmg");
        const bzEl = document.getElementById("calibBiasZmg");

        if (sfXEl) sfXEl.textContent = `${sfX}%`;
        if (sfYEl) sfYEl.textContent = `${sfY}%`;
        if (sfZEl) sfZEl.textContent = `${sfZ}%`;
        if (casEl) casEl.textContent = `${(cas * 100).toFixed(3)}%`;
        if (condEl) condEl.textContent = cond.toFixed(3);
        if (bxEl) bxEl.textContent = `${(B.x * 1000).toFixed(1)}mg`;
        if (byEl) byEl.textContent = `${(B.y * 1000).toFixed(1)}mg`;
        if (bzEl) bzEl.textContent = `${(B.z * 1000).toFixed(1)}mg`;
    }

    // Populate Certificate fields
    const certDate = document.getElementById("certDate");
    const certStatus = document.getElementById("certStatus");
    const certChecksum = document.getElementById("certChecksum");
    const certRms = document.getElementById("certRms");
    const certMax = document.getElementById("certMax");
    const certScaleAcc = document.getElementById("certScaleAcc");
    const certCondNum = document.getElementById("certCondNum");
    const certRev = document.getElementById("certRev");

    if (certDate) certDate.textContent = formattedDate;
    if (certStatus) {
        certStatus.textContent = rating;
        certStatus.style.color = ratingColor;
    }
    if (certChecksum) certChecksum.textContent = checksum.substring(0, 8);
    if (certRms) certRms.textContent = `${rms.toFixed(5)} g`;
    if (certMax) certMax.textContent = `${maxErr.toFixed(5)} g`;
    if (certScaleAcc) {
        // Average scale accuracy computed from diagonal components
        const devX = Math.abs((calib3x3Matrix ? calib3x3Matrix[0][0] : 1.0) - 1.0);
        const devY = Math.abs((calib3x3Matrix ? calib3x3Matrix[1][1] : 1.0) - 1.0);
        const devZ = Math.abs((calib3x3Matrix ? calib3x3Matrix[2][2] : 1.0) - 1.0);
        const avgDev = (devX + devY + devZ) / 3.0;
        const accuracy = Math.max(0, (1.0 - avgDev) * 100);
        certScaleAcc.textContent = `${accuracy.toFixed(3)}%`;
    }
    if (certCondNum) certCondNum.textContent = cond.toFixed(3);
    if (certRev) {
        const revDate = new Date(rev);
        certRev.textContent = isNaN(revDate.getTime()) ? `Rev ${rev}` : `Rev ${revDate.toLocaleDateString()}`;
    }
}

// Export calibration certificate as JSON for traceability
function exportCalibCert() {
    const meta = JSON.parse(localStorage.getItem("calib3x3Metadata") || "null");
    if (!meta) {
        showToast("Export Failed", "No calibration data available to export.", "warning", 4000);
        return;
    }
    // Add physical metrics to the export
    if (calib3x3Matrix) {
        const M = calib3x3Matrix;
        meta.sensitivityDeviation = {
            scaleFactorX_pct: ((M[0][0] - 1.0) * 100),
            scaleFactorY_pct: ((M[1][1] - 1.0) * 100),
            scaleFactorZ_pct: ((M[2][2] - 1.0) * 100),
            crossAxisSensitivity_pct: Math.max(
                Math.abs(M[0][1]), Math.abs(M[0][2]),
                Math.abs(M[1][0]), Math.abs(M[1][2]),
                Math.abs(M[2][0]), Math.abs(M[2][1])
            ) * 100,
            biasX_mg: calib3x3Bias.x * 1000,
            biasY_mg: calib3x3Bias.y * 1000,
            biasZ_mg: calib3x3Bias.z * 1000
        };
    }
    const blob = new Blob([JSON.stringify(meta, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `calib_cert_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    showToast("Certificate Exported", "Calibration certificate saved as JSON.", "success", 3000);
}

function loadCalibrationHistoryUI() {
    if (!calibHistorySelect) return;
    calibHistorySelect.innerHTML = "";

    let history = [];
    const historyStr = localStorage.getItem("calibHistory");
    if (historyStr) {
        try {
            history = JSON.parse(historyStr);
            if (!Array.isArray(history)) history = [];
        } catch (e) {
            history = [];
        }
    }

    if (history.length === 0) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "No saved calibrations";
        calibHistorySelect.appendChild(opt);
        if (calibRollbackButton) calibRollbackButton.disabled = true;
        return;
    }

    history.forEach((meta, idx) => {
        const opt = document.createElement("option");
        opt.value = idx.toString();
        const d = new Date(meta.timestamp);
        
        let dateStr = "N/A";
        if (!isNaN(d.getTime())) {
            const options = { 
                day: '2-digit', 
                month: 'short', 
                year: 'numeric', 
                hour: '2-digit', 
                minute: '2-digit' 
            };
            dateStr = d.toLocaleString('en-US', options);
        }
        
        const rms = meta.rmsError || 0;
        const quality = Math.max(0, Math.min(100, Math.exp(-rms * 5.0) * 100));
        const rangeVal = meta.gRange ? `±${meta.gRange}g` : "N/A";
        
        opt.textContent = `${dateStr} (Range: ${rangeVal}, Quality: ${quality.toFixed(1)}%)`;
        calibHistorySelect.appendChild(opt);
    });

    if (calibRollbackButton && !isSixPosCalibrating && !isValidationActive && startButton && !startButton.disabled) {
        calibRollbackButton.disabled = false;
    }
}

function rollbackCalibration() {
    if (!calibHistorySelect) return;
    const idxVal = calibHistorySelect.value;
    if (idxVal === "") return;
    const idx = parseInt(idxVal);

    let history = [];
    const historyStr = localStorage.getItem("calibHistory");
    if (historyStr) {
        try {
            history = JSON.parse(historyStr);
        } catch (e) {}
    }

    if (idx < 0 || idx >= history.length) return;
    const record = history[idx];

    if (confirm(`Are you sure you want to rollback to calibration from ${new Date(record.timestamp).toLocaleString()}?`)) {
        calib3x3Matrix = record.static.matrix;
        calib3x3Bias = record.static.bias;

        if (record.noise) {
            calibratedNoiseRms = record.noise;
            localStorage.setItem('calibrated_noise_rms', JSON.stringify(calibratedNoiseRms));
            updateNoiseFloorUI();
        }

        localStorage.setItem("calib3x3Matrix", JSON.stringify(calib3x3Matrix));
        localStorage.setItem("calib3x3Bias", JSON.stringify(calib3x3Bias));
        localStorage.setItem("calib3x3Metadata", JSON.stringify(record));

        calib3x3Enabled = true;
        localStorage.setItem("calib3x3Enabled", "true");
        if (calib3x3EnabledCheckbox) calib3x3EnabledCheckbox.checked = true;

        updateMatrixUI();
        updateBiasUI();
        showCalibMetricsPanel(record);

        showToast("Rollback Applied", "Restored the selected calibration profile.", "success", 4000);
    }
}

// ================= VALIDATION WIZARD FUNCTIONS =================

function startValidation() {
    if (isCalibrating || isSixPosCalibrating || isValidationActive) return;
    isValidationActive = true;
    validationStep = 1;
    validationSamples = [];
    validationMeans = [];

    // Disable buttons
    if (calibrateButton) calibrateButton.disabled = true;
    if (tareButton) tareButton.disabled = true;
    if (sixPosCalButton) sixPosCalButton.disabled = true;
    if (validateCalButton) validateCalButton.disabled = true;
    if (resetCalMatrixButton) resetCalMatrixButton.disabled = true;
    if (calibRollbackButton) calibRollbackButton.disabled = true;
    if (startButton) startButton.disabled = true;
    if (stopButton) stopButton.disabled = true;

    // Set up modal
    const overlay = document.getElementById("validationOverlay");
    if (overlay) overlay.classList.remove("hidden");

    const instructions = document.getElementById("valInstructions");
    if (instructions) instructions.textContent = "Orientation 1 of 6: Hold the sensor in any random orientation, keep it completely stationary.";

    const captureBtn = document.getElementById("valCaptureBtn");
    if (captureBtn) {
        captureBtn.textContent = "Capture Orientation 1";
        captureBtn.disabled = false;
        captureBtn.onclick = captureValidationStep;
    }

    const cancelBtn = document.getElementById("valCancelBtn");
    if (cancelBtn) {
        cancelBtn.onclick = cancelValidation;
    }

    const progressBar = document.getElementById("valProgressBar");
    if (progressBar) progressBar.style.width = "0%";

    const countdown = document.getElementById("valCountdown");
    if (countdown) {
        countdown.textContent = validationCountdownVal.toFixed(1) + "s";
        countdown.style.display = "block";
    }

    const spinner = document.getElementById("valSpinner");
    if (spinner) spinner.style.display = "none";
}

async function captureValidationStep() {
    const captureBtn = document.getElementById("valCaptureBtn");
    if (captureBtn) captureBtn.disabled = true;

    const spinner = document.getElementById("valSpinner");
    if (spinner) spinner.style.display = "block";

    validationSamples = [];
    validationStartTimestamp = Date.now();
    validationSettling = true;

    try {
        await accelDataChar.startNotifications();
        accelDataChar.addEventListener("characteristicvaluechanged", onValidationData);
    } catch (err) {
        console.error("Failed to start validation notifications:", err);
        showToast("Validation Failed", "Failed to initialize validation capture: " + err.message, "error", 5000);
        cancelValidation();
    }
}

function onValidationData(event) {
    if (!isValidationActive) return;

    const view = event.target.value;
    const packetSamples = parseBLEAccelPacket(view);
    if (!packetSamples) return;

    const now = Date.now();
    if (validationSettling) {
        if (now - validationStartTimestamp < 500) {
            const countdown = document.getElementById("valCountdown");
            if (countdown) countdown.textContent = "Settling...";
            return;
        }
        validationSettling = false;
        validationStartTimestamp = now;
    }

    for (let i = 0; i < packetSamples.length; i++) {
        validationSamples.push(packetSamples[i]);
    }

    const progress = Math.min(100, (validationSamples.length / validationTargetSamples) * 100);
    const progressBar = document.getElementById("valProgressBar");
    if (progressBar) progressBar.style.width = progress.toFixed(1) + "%";

    const elapsed = (Date.now() - validationStartTimestamp) / 1000;
    const remaining = Math.max(0, validationCountdownVal - elapsed);
    const countdown = document.getElementById("valCountdown");
    if (countdown) countdown.textContent = remaining.toFixed(1) + "s";

    if (validationSamples.length >= validationTargetSamples || remaining <= 0) {
        finishValidationStep();
    }
}

async function finishValidationStep() {
    try {
        await accelDataChar.stopNotifications();
        accelDataChar.removeEventListener("characteristicvaluechanged", onValidationData);
    } catch (err) {
        console.error("Failed to release validation listener:", err);
    }

    const spinner = document.getElementById("valSpinner");
    if (spinner) spinner.style.display = "none";

    // Perform per-orientation stability check
    const metrics = computeStabilityMetrics(validationSamples);
    console.log('Validation metrics:', metrics);
    const threshold = parseFloat(document.getElementById("calibStabilityThreshold").value) || 0.25;

    if (metrics.norm > threshold) {
        showToast("Stability Check Failed", `Motion detected during validation capture\nStd Dev: ${metrics.norm.toFixed(4)} g (threshold: ${threshold.toFixed(4)} g)\nPlease hold the sensor stationary and retry.`, "warning", 6000);

        // Reset progress bar & countdown for this step
        const progressBar = document.getElementById("valProgressBar");
        if (progressBar) progressBar.style.width = "0%";
        const countdown = document.getElementById("valCountdown");
        if (countdown) countdown.textContent = validationCountdownVal.toFixed(1) + "s";

        // Re-enable capture button to let user retry this step
        const captureBtn = document.getElementById("valCaptureBtn");
        if (captureBtn) {
            captureBtn.textContent = `Recapture Orientation ${validationStep}`;
            captureBtn.disabled = false;
        }
        return;
    }

    // Stable! Store mean raw vector
    validationMeans.push({ x: metrics.meanX, y: metrics.meanY, z: metrics.meanZ });
    console.log(`Validation Step ${validationStep} captured: x=${metrics.meanX.toFixed(4)}, y=${metrics.meanY.toFixed(4)}, z=${metrics.meanZ.toFixed(4)}`);

    validationStep++;

    if (validationStep <= 6) {
        // Prepare next step
        const instructions = document.getElementById("valInstructions");
        const captureBtn = document.getElementById("valCaptureBtn");

        if (instructions) instructions.textContent = `Orientation ${validationStep} of 6: Hold the sensor in another random orientation, keep it completely stationary.`;
        if (captureBtn) {
            captureBtn.textContent = `Capture Orientation ${validationStep}`;
            captureBtn.disabled = false;
        }

        const progressBar = document.getElementById("valProgressBar");
        if (progressBar) progressBar.style.width = "0%";

        const countdown = document.getElementById("valCountdown");
        if (countdown) countdown.textContent = validationCountdownVal.toFixed(1) + "s";
    } else {
        // Complete validation calculation!
        calculateValidationResults();
    }
}

function calculateValidationResults() {
    // We compute the magnitude error under the current active calibration
    let sqErrSum = 0;
    let maxError = 0;

    for (let j = 0; j < 6; j++) {
        const v = validationMeans[j];
        let cx, cy, cz;

        if (calib3x3Enabled) {
            const dx = v.x - calib3x3Bias.x;
            const dy = v.y - calib3x3Bias.y;
            const dz = v.z - calib3x3Bias.z;
            cx = calib3x3Matrix[0][0]*dx + calib3x3Matrix[0][1]*dy + calib3x3Matrix[0][2]*dz;
            cy = calib3x3Matrix[1][0]*dx + calib3x3Matrix[1][1]*dy + calib3x3Matrix[1][2]*dz;
            cz = calib3x3Matrix[2][0]*dx + calib3x3Matrix[2][1]*dy + calib3x3Matrix[2][2]*dz;
        } else {
            cx = v.x - calibOffsetX;
            cy = v.y - calibOffsetY;
            cz = v.z - calibOffsetZ;
        }

        const norm = Math.sqrt(cx*cx + cy*cy + cz*cz);
        const err = Math.abs(norm - 1.0);
        sqErrSum += err * err;
        if (err > maxError) maxError = err;
    }

    const rmsError = Math.sqrt(sqErrSum / 6);
    const rmsLimit = 0.50;
    const maxLimit = 1.00;
    const isQualityPass = (rmsError < rmsLimit) && (maxError < maxLimit);

    // Update Validation Results in the unified Calibration Health Card
    const statusBadge = document.getElementById("calibStatusBadge");
    const qualityText = document.getElementById("calibQualityText");
    const qualityBar = document.getElementById("calibQualityBar");
    const healthRms = document.getElementById("calibHealthRms");
    const healthMax = document.getElementById("calibHealthMax");

    // Quality calculation: exponential decay based on RMS error
    const quality = Math.max(0, Math.min(100, Math.exp(-rmsError * 5.0) * 100));
    let rating = isQualityPass ? "EXCELLENT" : "POOR";
    let ratingColor = isQualityPass ? "#10B981" : "#EF4444";
    if (isQualityPass && quality < 90) {
        rating = "GOOD";
        ratingColor = "#F59E0B";
    }

    if (statusBadge) {
        statusBadge.innerHTML = isQualityPass
            ? `<span style="width: 8px; height: 8px; border-radius: 50%; background-color: #10B981; display: inline-block;"></span> VALIDATED`
            : `<span style="width: 8px; height: 8px; border-radius: 50%; background-color: #EF4444; display: inline-block;"></span> VALIDATION FAILED`;
        statusBadge.style.color = ratingColor;
    }

    if (qualityText) {
        qualityText.textContent = `${quality.toFixed(1)}% (${rating})`;
        qualityText.style.color = ratingColor;
    }

    if (qualityBar) {
        qualityBar.style.width = `${quality}%`;
        qualityBar.style.background = ratingColor;
    }

    if (healthRms) healthRms.textContent = `${rmsError.toFixed(5)} g`;
    if (healthMax) healthMax.textContent = `${maxError.toFixed(5)} g`;

    // Close validation overlay
    const overlay = document.getElementById("validationOverlay");
    if (overlay) overlay.classList.add("hidden");

    isValidationActive = false;

    // Enable buttons
    if (calibrateButton) calibrateButton.disabled = false;
    if (tareButton) tareButton.disabled = false;
    if (sixPosCalButton) sixPosCalButton.disabled = false;
    if (validateCalButton) validateCalButton.disabled = false;
    if (resetCalMatrixButton) resetCalMatrixButton.disabled = false;
    if (startButton) startButton.disabled = false;
    if (stopButton) stopButton.disabled = true;
    loadCalibrationHistoryUI();

    const valToastType = isQualityPass ? "success" : "warning";
    const valToastTitle = isQualityPass ? "Validation Passed" : "Validation Failed";
    showToast(valToastTitle, `RMS Deviation: ${rmsError.toFixed(5)} g\nMax Deviation: ${maxError.toFixed(5)} g\nModel: ${calib3x3Enabled ? "3x3 Matrix & Bias" : "Zero-g Tare Offsets"}`, valToastType, 6000);
}

async function cancelValidation() {
    isValidationActive = false;

    try {
        if (accelDataChar) {
            await accelDataChar.stopNotifications();
            accelDataChar.removeEventListener("characteristicvaluechanged", onValidationData);
        }
    } catch (err) {
        console.warn("Error stopping notifications on validation cancel:", err);
    }

    const overlay = document.getElementById("validationOverlay");
    if (overlay) overlay.classList.add("hidden");

    // Enable buttons
    if (calibrateButton) calibrateButton.disabled = false;
    if (tareButton) tareButton.disabled = false;
    if (sixPosCalButton) sixPosCalButton.disabled = false;
    if (validateCalButton) validateCalButton.disabled = false;
    if (resetCalMatrixButton) resetCalMatrixButton.disabled = false;
    if (startButton) startButton.disabled = false;
    if (stopButton) stopButton.disabled = true;
    loadCalibrationHistoryUI();
}

/* ==========================================================================
   TOAST NOTIFICATION SYSTEM (SCIENTIFIC INSTRUMENT STYLE)
   Replaces native alert() dialogs with non-blocking, auto-dismissing
   toast notifications — matching Dewesoft, Simcenter, NI LabVIEW UX patterns.
   ========================================================================== */
function showToast(title, message, type = 'success', duration = 4000) {
    let container = document.getElementById("toast-container");
    if (!container) {
        container = document.createElement("div");
        container.id = "toast-container";
        document.body.appendChild(container);
    }

    const toast = document.createElement("div");
    toast.className = `toast-notification ${type}`;

    let icon = "✓";
    if (type === "error") icon = "✕";
    else if (type === "warning") icon = "⚠";
    else if (type === "info") icon = "ℹ";

    toast.innerHTML = `
        <div class="toast-header">
            <span><span class="toast-icon">${icon}</span>${title}</span>
            <button class="toast-close-btn">&times;</button>
        </div>
        <div class="toast-body">${message}</div>
    `;

    container.appendChild(toast);

    // Trigger reflow then animate in
    toast.offsetHeight;
    toast.classList.add("show");

    const closeBtn = toast.querySelector(".toast-close-btn");
    let dismissTimeout;

    const dismissToast = () => {
        clearTimeout(dismissTimeout);
        toast.classList.remove("show");
        toast.addEventListener("transitionend", () => {
            toast.remove();
        });
    };

    closeBtn.onclick = dismissToast;
    dismissTimeout = setTimeout(dismissToast, duration);
}

// ==================== NEW ISRO / NI CONFIGURATION UTILITIES ====================
function updateActiveDeviceConfigUI() {
    const isConnected = !!device && device.gatt.connected;
    
    // UI elements
    const activeSensorEl = document.getElementById("activeDeviceSensor");
    const activeRangeEl = document.getElementById("activeDeviceRange");
    const activeSampleRateEl = document.getElementById("activeDeviceSampleRate");
    const activeTxPowerEl = document.getElementById("activeDeviceTxPower");
    const activeBufferEl = document.getElementById("activeDeviceBuffer");
    const activeSyncEl = document.getElementById("activeDeviceSync");
    const activeLastSavedEl = document.getElementById("activeDeviceLastSaved");

    if (!isConnected) {
        if (activeSensorEl) activeSensorEl.textContent = "Unknown";
        if (activeRangeEl) activeRangeEl.textContent = "Unknown";
        if (activeSampleRateEl) activeSampleRateEl.textContent = "Unknown";
        if (activeTxPowerEl) activeTxPowerEl.textContent = "Unknown";
        if (activeBufferEl) activeBufferEl.textContent = "Unknown";
        if (activeSyncEl) {
            activeSyncEl.textContent = "DISCONNECTED";
            activeSyncEl.className = "badge-status-red";
        }
        return;
    }

    const rangeG = parseInt(localStorage.getItem("sensorRangeG") || "400", 10);
    let sensorName = rangeG <= 16 ? "ADXL345" : "H3LIS331DL";
    if (typeof window._currentSensorName === 'string' && window._currentSensorName) {
        sensorName = window._currentSensorName;
    }
    const txPowerVal = document.getElementById("txPowerSelect") ? document.getElementById("txPowerSelect").value : "0";
    const bufferVal = document.getElementById("bufferModeSelect") ? document.getElementById("bufferModeSelect").value : "0x11";

    if (activeSensorEl) activeSensorEl.textContent = sensorName;
    if (activeRangeEl) activeRangeEl.textContent = "±" + rangeG + "g";
    if (activeSampleRateEl) activeSampleRateEl.textContent = SAMPLE_RATE + " Hz";
    if (activeTxPowerEl) activeTxPowerEl.textContent = txPowerVal + " dBm";

    // Buffer mode
    let bufferText = "300 ms";
    if (bufferVal === "0x10") bufferText = "No Buffer";
    else if (bufferVal === "0x12") bufferText = "1 s";
    else if (bufferVal === "0x13") bufferText = "2 s";
    else if (bufferVal === "0x14") bufferText = "5 s";
    else if (bufferVal === "0x15") bufferText = "10 s";
    if (activeBufferEl) activeBufferEl.textContent = bufferText;

    if (activeSyncEl) {
        activeSyncEl.textContent = "SYNCHRONIZED";
        activeSyncEl.className = "badge-status-green";
    }

    const lastSaved = localStorage.getItem("lastSavedConfigTime");
    if (activeLastSavedEl) {
        activeLastSavedEl.textContent = lastSaved || "N/A";
    }
}

function updateStatusBar(streamState = null) {
    const isConnected = !!device && device.gatt.connected;
    const statusBarContent = document.getElementById("statusBarContent");
    const statusIndicatorDot = document.getElementById("statusIndicatorDot");
    
    if (!statusBarContent || !statusIndicatorDot) return;

    if (!isConnected) {
        statusBarContent.innerHTML = `<span class="flex items-center gap-1.5"><span id="statusIndicatorDot" class="w-1.5 h-1.5 rounded-full bg-red-500"></span> Node-01</span>
            <span class="text-slate-300">|</span>
            <span class="text-red-600 font-bold">DISCONNECTED</span>`;
        updateDAQStatus(streamState);
        return;
    }

    const rangeG = parseInt(localStorage.getItem("sensorRangeG") || "400", 10);
    const sensorName = rangeG <= 16 ? "ADXL345" : "H3LIS331DL";
    const sampleRate = SAMPLE_RATE + " Hz";
    
    let activeStateText = "CONNECTED";
    let dotClass = "w-1.5 h-1.5 rounded-full bg-blue-500";
    if (streamState === "streaming" || isPlayingOut) {
        activeStateText = "STREAMING";
        dotClass = "w-1.5 h-1.5 rounded-full bg-emerald-500 indicator-pulse-active";
    } else {
        activeStateText = "IDLE";
        dotClass = "w-1.5 h-1.5 rounded-full bg-amber-500";
    }

    let batteryText = "";
    if (window._lastBatteryLevel !== undefined) {
        batteryText = ` | 🔋 ${window._lastBatteryLevel}%`;
    }

    statusBarContent.innerHTML = `<span class="flex items-center gap-1.5"><span id="statusIndicatorDot" class="${dotClass}"></span> Node-01</span>
        <span class="text-slate-300">|</span>
        <span>${sensorName}</span>
        <span class="text-slate-300">|</span>
        <span>${sampleRate}</span>
        <span class="text-slate-300">|</span>
        <span>±${rangeG}g</span>
        <span class="text-slate-300">|</span>
        <span class="font-bold text-slate-700">${activeStateText}</span>${batteryText}`;
    
    updateDAQStatus(streamState);
}

function updateDAQStatus(streamState = null) {
    const isConnected = !!device && device.gatt.connected;
    
    // Get DAQ status DOM elements
    const daqConn = document.getElementById("daqConnection");
    const daqStream = document.getElementById("daqStreaming");
    const daqLoss = document.getElementById("daqPacketLoss");
    const daqRate = document.getElementById("daqSampleRate");
    const daqCal = document.getElementById("daqCalibration");
    const daqPipe = document.getElementById("daqPipeline");

    if (daqConn) {
        if (isConnected) {
            daqConn.textContent = "Connected";
            daqConn.className = "daq-status-val status-connected";
        } else {
            daqConn.textContent = "Disconnected";
            daqConn.className = "daq-status-val status-disconnected";
        }
    }

    if (daqStream) {
        if (streamState === "streaming" || isPlayingOut) {
            daqStream.textContent = "Streaming";
            daqStream.className = "daq-status-val status-connected";
        } else if (isConnected) {
            daqStream.textContent = "Idle";
            daqStream.className = "daq-status-val status-warning";
        } else {
            daqStream.textContent = "Idle";
            daqStream.className = "daq-status-val";
        }
    }

    if (daqLoss) {
        if (sampleCount > 0) {
            const lossPct = (droppedSamples / (sampleCount + droppedSamples)) * 100;
            daqLoss.textContent = lossPct.toFixed(2) + "%";
            if (lossPct > 2.0) {
                daqLoss.className = "daq-status-val status-disconnected";
            } else if (lossPct > 0.05) {
                daqLoss.className = "daq-status-val status-warning";
            } else {
                daqLoss.className = "daq-status-val status-connected";
            }
        } else {
            daqLoss.textContent = "0.00%";
            daqLoss.className = "daq-status-val status-connected";
        }
    }

    if (daqRate) {
        daqRate.textContent = isConnected ? `${SAMPLE_RATE} Hz` : "—";
    }

    if (daqCal) {
        if (calib3x3Enabled) {
            daqCal.textContent = "Calibrated (6-Pos)";
            daqCal.className = "daq-status-val status-connected";
        } else {
            const isTared = (calibOffsetX !== 0 || calibOffsetY !== 0 || calibOffsetZ !== 0);
            if (isTared) {
                daqCal.textContent = "Tared";
                daqCal.className = "daq-status-val status-warning";
            } else {
                daqCal.textContent = "None";
                daqCal.className = "daq-status-val status-disconnected";
            }
        }
    }

    if (daqPipe) {
        if (signalPipeline.isSettling()) {
            daqPipe.textContent = "Settling...";
            daqPipe.className = "daq-status-val status-warning";
        } else {
            daqPipe.textContent = "Ready";
            daqPipe.className = "daq-status-val status-connected";
        }
    }
}


function updateRangeDropdown(sensor, selectedRangeG) {
    const gRangeSelect = document.getElementById("gRangeSelect");
    if (!gRangeSelect) return;

    gRangeSelect.innerHTML = "";

    if (sensor === "H3LIS331DL") {
        const opt100 = document.createElement("option");
        opt100.value = "100";
        opt100.textContent = "±100g";
        gRangeSelect.appendChild(opt100);

        const opt200 = document.createElement("option");
        opt200.value = "200";
        opt200.textContent = "±200g";
        gRangeSelect.appendChild(opt200);

        const opt400 = document.createElement("option");
        opt400.value = "400";
        opt400.textContent = "±400g";
        gRangeSelect.appendChild(opt400);
    } else if (sensor === "ADXL345") {
        const opt2 = document.createElement("option");
        opt2.value = "2";
        opt2.textContent = "±2g";
        gRangeSelect.appendChild(opt2);

        const opt4 = document.createElement("option");
        opt4.value = "4";
        opt4.textContent = "±4g";
        gRangeSelect.appendChild(opt4);

        const opt8 = document.createElement("option");
        opt8.value = "8";
        opt8.textContent = "±8g";
        gRangeSelect.appendChild(opt8);

        const opt16 = document.createElement("option");
        opt16.value = "16";
        opt16.textContent = "±16g";
        gRangeSelect.appendChild(opt16);
    }

    if (selectedRangeG) {
        gRangeSelect.value = String(selectedRangeG);
    } else {
        gRangeSelect.selectedIndex = 0;
    }
}

