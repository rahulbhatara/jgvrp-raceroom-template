// State & DOM Elements
let elements = {};
let ws = null;
let reconnectTimer = null;
let hasReceivedLap = false;

// Dynamic Track Minimap Elements
let trackCanvas = null;
let trackCtx = null;

// Initialize DOM element references
document.addEventListener('DOMContentLoaded', () => {
    elements = {
        mode: document.getElementById('race-mode'),
        lap: document.getElementById('lap-display'),
        time: document.getElementById('time-display'),
        scoreboardBody: document.getElementById('scoreboard-body'),
        thLap: document.getElementById('th-lap'),
        thTime: document.getElementById('th-time')
    };

    trackCanvas = document.getElementById('track-canvas');
    if (trackCanvas) {
        trackCtx = trackCanvas.getContext('2d');
    }

    // Re-render minimap when Formula1 font finishes loading
    if (document.fonts) {
        document.fonts.ready.then(() => {
            if (trackCanvas && trackCtx && lastDriversPayload.length > 0) {
                drawTrackMinimap(lastDriversPayload);
            }
        });
    }

    initWebSocket();
});

let reconnectAttempts = 0;

/**
 * Initialize WebSocket connection to Python backend (for development / debugging)
 * Runs only on localhost or when ?telemetry=true is specified.
 */
function initWebSocket() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol === 'file:';
    const wantTelemetry = isLocal || window.location.search.includes('telemetry=true');

    if (!wantTelemetry) {
        if (elements.wsIndicator) elements.wsIndicator.style.display = 'none';
        return;
    }

    let wsUrl;
    if (window.location.protocol === 'file:') {
        wsUrl = 'ws://localhost:6767/ws';
    } else {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${protocol}//${window.location.host}/ws`;
    }

    try {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log('[RaceRoom Telemetry] Connected to backend:', wsUrl);
            reconnectAttempts = 0;
            if (elements.wsIndicator) {
                elements.wsIndicator.style.display = 'block';
                elements.wsIndicator.classList.add('connected');
                elements.wsIndicator.title = 'Telemetry Connected';
            }
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'setMode' && elements.mode) {
                    setRaceMode(data.mode);
                }
            } catch (_) {}
        };

        ws.onclose = () => {
            if (elements.wsIndicator) {
                elements.wsIndicator.classList.remove('connected');
            }
            if (reconnectAttempts < 3) {
                reconnectAttempts++;
                reconnectTimer = setTimeout(initWebSocket, 2000);
            } else if (elements.wsIndicator) {
                elements.wsIndicator.style.display = 'none';
            }
        };

        ws.onerror = () => {
            try { ws.close(); } catch (_) {}
        };
    } catch (_) {
        if (elements.wsIndicator) elements.wsIndicator.style.display = 'none';
    }
}

/**
 * Forward function call data to the Python WebSocket backend
 */
function sendTelemetry(funcName, args) {
    const payload = {
        function: funcName,
        args: Array.from(args),
        timestamp: Date.now(),
        iso_time: new Date().toISOString()
    };

    if (elements.lastEvent) {
        elements.lastEvent.innerText = `[${new Date().toLocaleTimeString()}] ${funcName}(${args.length} args)`;
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

/**
 * Set the visual race mode badge (sprint, circuit, endurance)
 */
function setRaceMode(mode) {
    if (!elements.mode) return;
    const cleanMode = String(mode).toLowerCase();
    elements.mode.className = 'race-badge ' + cleanMode;
    elements.mode.innerText = cleanMode.toUpperCase();
}

/**
 * Format milliseconds or seconds to MM:SS
 */
function formatTime(val) {
    if (typeof val === 'string') return val;
    if (typeof val === 'number') {
        const totalSec = Math.floor(val > 100000 ? val / 1000 : val);
        const hours = Math.floor(totalSec / 3600);
        const minutes = Math.floor((totalSec % 3600) / 60);
        const seconds = Math.floor(totalSec % 60);

        if (hours > 0) {
            return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        }
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return String(val ?? '--:--');
}

// Dynamic Track Silhouette & Pit Lane State
let trackPoints = [];       // Main circuit path
let pitPoints = [];         // Pit lane path (if detected)
let isLoopClosed = false;   // Circuit closed loop flag
let trackBounds = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity
};

function expandBounds(gx, gy) {
    if (gx < trackBounds.minX) trackBounds.minX = gx;
    if (gx > trackBounds.maxX) trackBounds.maxX = gx;
    if (gy < trackBounds.minY) trackBounds.minY = gy;
    if (gy > trackBounds.maxY) trackBounds.maxY = gy;
}

// Telemetry history per driver for smart crash & pit detection
const driverHistories = {};
let lastDriversPayload = [];

/**
 * Records breadcrumbs with Multi-Car Crash Rejection & Pit Lane Auto-Detection
 */
function updateTrackMap(drivers) {
    if (!trackCanvas || !trackCtx || !drivers || drivers.length === 0) return;
    lastDriversPayload = drivers;

    const now = Date.now();
    const validDrivers = [];

    // 1. Analyze each driver's telemetry: speed, heading, angle change, crash/spin status
    for (let i = 0; i < drivers.length; i++) {
        const d = drivers[i];
        if (!d.position || typeof d.position.x !== 'number' || typeof d.position.y !== 'number') continue;

        const name = d.name || `driver_${i}`;
        const gx = d.position.x;
        const gy = d.position.y;
        const cp = typeof d.checkpoints === 'number' ? d.checkpoints : 0;
        const hist = driverHistories[name];

        let speedKmh = 0;
        let heading = 0;
        let angleDelta = 0;
        let isSpinning = false;
        let isStalled = false;

        if (hist) {
            const dt = (now - hist.time) / 1000;
            const dist = Math.hypot(gx - hist.x, gy - hist.y);

            if (dt > 0.05) {
                speedKmh = (dist / dt) * 3.6;
                heading = Math.atan2(gy - hist.y, gx - hist.x);

                if (hist.heading !== undefined && dist >= 1.5) {
                    angleDelta = Math.abs(heading - hist.heading);
                    if (angleDelta > Math.PI) angleDelta = 2 * Math.PI - angleDelta;

                    // If heading changed > 70 deg abruptly and speed dropped drastically, mark as spin/crash
                    if (angleDelta > 1.2 && hist.speedKmh > 35 && speedKmh < hist.speedKmh * 0.5) {
                        isSpinning = true;
                    }
                }

                // If moving < 15 km/h, considered stalled / crashed / off-pace
                if (speedKmh < 15) {
                    isStalled = true;
                }
            }
        }

        // Save telemetry history
        driverHistories[name] = {
            x: gx,
            y: gy,
            time: now,
            speedKmh: speedKmh || (hist ? hist.speedKmh : 0),
            heading: heading || (hist ? hist.heading : 0),
            checkpoints: cp,
            rank: i + 1,
            isSpinning: isSpinning,
            isStalled: isStalled
        };

        // If not spinning, not stalled, and not glitching, consider valid for track recording
        if (!isSpinning && !isStalled && speedKmh < 450) {
            validDrivers.push({
                name,
                x: gx,
                y: gy,
                checkpoints: cp,
                rank: i + 1,
                speedKmh
            });
        }
    }

    // 2. Main Track Tracing (Resilient to Crash / Spin)
    if (!isLoopClosed) {
        // Pick best clean driver: highest checkpoints, lowest rank, moving cleanly
        let tracer = null;
        if (validDrivers.length > 0) {
            validDrivers.sort((a, b) => (b.checkpoints - a.checkpoints) || (a.rank - b.rank));
            tracer = validDrivers[0];
        } else if (trackPoints.length === 0 && drivers.length > 0 && drivers[0].position) {
            // First initial point from leader before movement starts
            tracer = { x: drivers[0].position.x, y: drivers[0].position.y };
        }

        if (tracer) {
            const lastPt = trackPoints[trackPoints.length - 1];

            // Only add point if moved at least 6 meters from previous point
            if (!lastPt || Math.hypot(tracer.x - lastPt.x, tracer.y - lastPt.y) >= 6) {
                // If we have >= 25 points and car has returned close to the start line (<= 16m), close loop!
                if (trackPoints.length >= 25 && Math.hypot(tracer.x - trackPoints[0].x, tracer.y - trackPoints[0].y) <= 16) {
                    isLoopClosed = true;
                } else {
                    trackPoints.push({ x: tracer.x, y: tracer.y });
                    expandBounds(tracer.x, tracer.y);
                }
            }
        }
    }

    // 3. Pit Lane Auto-Detection (Corridor 6m - 35m parallel to Start/Finish, speed 15-90 km/h)
    if (trackPoints.length >= 10) {
        const startPt = trackPoints[0];

        drivers.forEach(d => {
            if (!d.position || typeof d.position.x !== 'number') return;
            const gx = d.position.x;
            const gy = d.position.y;
            const hist = driverHistories[d.name];
            if (!hist) return;

            // Distance to start/finish line
            const distToStart = Math.hypot(gx - startPt.x, gy - startPt.y);

            // Pit lane is within 180m sector of start/finish
            if (distToStart <= 180) {
                let minDistToMain = Infinity;
                for (let k = 0; k < trackPoints.length; k++) {
                    const dMain = Math.hypot(gx - trackPoints[k].x, gy - trackPoints[k].y);
                    if (dMain < minDistToMain) minDistToMain = dMain;
                }

                // If laterally offset 6m - 35m from main track, and driving at pit speed (15 - 90 km/h)
                if (minDistToMain >= 6 && minDistToMain <= 35 && hist.speedKmh >= 15 && hist.speedKmh <= 90 && !hist.isSpinning) {
                    const lastPit = pitPoints[pitPoints.length - 1];
                    if (!lastPit || Math.hypot(gx - lastPit.x, gy - lastPit.y) >= 5) {
                        pitPoints.push({ x: gx, y: gy });
                        expandBounds(gx, gy);
                    }
                }
            }
        });
    }

    drawTrackMinimap(drivers);
}

/**
 * Draws the dynamic 2D track silhouette, pit lane, and moving driver blips on HTML5 Canvas (4:3 aspect ratio)
 */
function drawTrackMinimap(drivers) {
    if (!trackCanvas || !trackCtx) return;

    const w = trackCanvas.width;
    const h = trackCanvas.height;

    trackCtx.clearRect(0, 0, w, h);

    // Background
    trackCtx.fillStyle = '#080d1a';
    trackCtx.fillRect(0, 0, w, h);

    // Subtle crosshair lines
    trackCtx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    trackCtx.lineWidth = 1;
    trackCtx.beginPath();
    trackCtx.moveTo(w / 2, 0); trackCtx.lineTo(w / 2, h);
    trackCtx.moveTo(0, h / 2); trackCtx.lineTo(w, h / 2);
    trackCtx.stroke();

    if (trackPoints.length < 2) {
        trackCtx.fillStyle = '#64748b';
        trackCtx.font = 'bold 12px Formula1, sans-serif';
        trackCtx.textAlign = 'center';
        trackCtx.fillText('AUTO-MAPPING TRACK...', w / 2, h / 2 + 4);
        return;
    }

    // Auto-scale with padding to preserve 4:3 aspect ratio
    const pad = 22;
    const spanX = Math.max(trackBounds.maxX - trackBounds.minX, 40);
    const spanY = Math.max(trackBounds.maxY - trackBounds.minY, 40);
    const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);

    const midX = (trackBounds.minX + trackBounds.maxX) / 2;
    const midY = (trackBounds.minY + trackBounds.maxY) / 2;

    function toCanvas(gx, gy) {
        return {
            x: (w / 2) + (gx - midX) * scale,
            y: (h / 2) - (gy - midY) * scale // Invert GTA Y (+Y is North)
        };
    }

    // 1. Draw Pit Lane (if detected)
    if (pitPoints.length >= 2) {
        trackCtx.beginPath();
        trackCtx.setLineDash([5, 4]);
        const pitStart = toCanvas(pitPoints[0].x, pitPoints[0].y);
        trackCtx.moveTo(pitStart.x, pitStart.y);

        for (let i = 1; i < pitPoints.length; i++) {
            const pt = toCanvas(pitPoints[i].x, pitPoints[i].y);
            trackCtx.lineTo(pt.x, pt.y);
        }

        trackCtx.strokeStyle = 'rgba(245, 158, 11, 0.85)'; // Amber pit lane
        trackCtx.lineWidth = 2.5;
        trackCtx.lineCap = 'round';
        trackCtx.lineJoin = 'round';
        trackCtx.stroke();
        trackCtx.setLineDash([]); // Reset dash

        // Draw small "PIT" label at midpoint
        if (pitPoints.length >= 4) {
            const midIdx = Math.floor(pitPoints.length / 2);
            const midPt = toCanvas(pitPoints[midIdx].x, pitPoints[midIdx].y);
            trackCtx.fillStyle = '#f59e0b';
            trackCtx.font = 'bold 9px Formula1, sans-serif';
            trackCtx.textAlign = 'center';
            trackCtx.fillText('PIT', midPt.x, midPt.y - 6);
        }
    }

    // 2. Draw Main Track Silhouette (Continuous Racing Line)
    trackCtx.beginPath();
    const startPt = toCanvas(trackPoints[0].x, trackPoints[0].y);
    trackCtx.moveTo(startPt.x, startPt.y);

    for (let i = 1; i < trackPoints.length; i++) {
        const pt = toCanvas(trackPoints[i].x, trackPoints[i].y);
        trackCtx.lineTo(pt.x, pt.y);
    }

    if (isLoopClosed) {
        trackCtx.closePath();
    }

    // Outer neon glow line
    trackCtx.strokeStyle = 'rgba(59, 130, 246, 0.4)';
    trackCtx.lineWidth = 4;
    trackCtx.lineCap = 'round';
    trackCtx.lineJoin = 'round';
    trackCtx.stroke();

    // Inner crisp track line
    trackCtx.strokeStyle = '#38bdf8';
    trackCtx.lineWidth = 1.6;
    trackCtx.stroke();

    // 3. Draw Start/Finish Line marker (white point at startPt)
    trackCtx.fillStyle = '#f8fafc';
    trackCtx.beginPath();
    trackCtx.arc(startPt.x, startPt.y, 3.5, 0, Math.PI * 2);
    trackCtx.fill();

    // 4. Draw All Driver Blips (drawn in reverse so P1 is on top)
    for (let i = drivers.length - 1; i >= 0; i--) {
        const d = drivers[i];
        if (!d.position || typeof d.position.x !== 'number') continue;
        const pt = toCanvas(d.position.x, d.position.y);
        const pos = typeof d.rank === 'number' ? d.rank : (i + 1);

        const isP1 = pos === 1;
        const color = isP1 ? '#10b981' : '#f59e0b'; // Emerald for P1, amber for P2+

        // Dot
        trackCtx.fillStyle = color;
        trackCtx.beginPath();
        trackCtx.arc(pt.x, pt.y, isP1 ? 5.5 : 4.5, 0, Math.PI * 2);
        trackCtx.fill();

        // Border around dot
        trackCtx.strokeStyle = '#ffffff';
        trackCtx.lineWidth = 1.2;
        trackCtx.stroke();

        // Driver position number label
        trackCtx.fillStyle = '#f8fafc';
        trackCtx.font = 'bold 10px Formula1, sans-serif';
        trackCtx.textAlign = 'center';
        trackCtx.fillText(String(pos), pt.x, pt.y - 7);
    }
}

// ==========================================
// 3 CORE RACEROOM FUNCTIONS CALLED BY JGVRP
// ==========================================

/**
 * Updates the race scoreboard / leaderboard.
 * Called directly by JGVRP FiveM client.
 */
function updateScoreboard(...args) {
    console.log('[RaceRoom] updateScoreboard:', ...args);
    sendTelemetry('updateScoreboard', args);

    if (!elements.scoreboardBody) return;

    // Normalize arguments: could be array of items, or object containing items, or JSON string
    let data = args[0];
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (_) {}
    }

    let rows = [];
    if (Array.isArray(data)) {
        rows = data;
    } else if (data && typeof data === 'object') {
        if (Array.isArray(data.scoreboard)) rows = data.scoreboard;
        else if (Array.isArray(data.players)) rows = data.players;
        else if (Array.isArray(data.drivers)) rows = data.drivers;
        else if (Array.isArray(data.data)) rows = data.data;
        else rows = [data];

        // Mode detection if provided in the object
        if (data.mode) {
            setRaceMode(data.mode);
        }
    }

    if (!rows || rows.length === 0) {
        elements.scoreboardBody.innerHTML = `
            <tr class="placeholder-row">
                <td colspan="4">Menunggu peserta balapan...</td>
            </tr>
        `;
        return;
    }

    let html = '';
    rows.forEach((item, index) => {
        // Resolve position: note that item.position is GTA 3D coords {x, y, z}, so use index + 1
        const pos = typeof item.rank === 'number' ? item.rank : (index + 1);
        const posClass = pos === 1 ? 'pos-1' : pos === 2 ? 'pos-2' : pos === 3 ? 'pos-3' : '';

        // Resolve driver name
        const name = item.name ?? item.driver ?? item.player ?? item.username ?? `Driver #${pos}`;

        // Resolve lap / checkpoint (JGVRP sends item.checkpoints)
        let lapVal = '-';
        if (item.checkpoints !== undefined) {
            lapVal = `${item.checkpoints}`;
        } else if (item.checkpoint !== undefined) {
            lapVal = `${item.checkpoint}`;
        } else if (item.lap !== undefined && item.totalLaps !== undefined) {
            lapVal = `${item.lap}/${item.totalLaps}`;
        } else if (item.lap !== undefined) {
            lapVal = `${item.lap}`;
        }

        // Resolve time / gap (JGVRP sends item.timeDiff in milliseconds)
        let timeVal = '-';
        if (item.timeDiff !== undefined) {
            if (pos === 1 || item.timeDiff === 0) {
                timeVal = '<span style="color: #10b981; font-weight: 700;">LEADER</span>';
            } else {
                const diffSec = item.timeDiff / 1000;
                if (diffSec < 60) {
                    timeVal = `+${diffSec.toFixed(2)}s`;
                } else {
                    timeVal = `+${formatTime(Math.floor(diffSec))}`;
                }
            }
        } else if (item.time !== undefined) {
            timeVal = formatTime(item.time);
        } else if (item.gap !== undefined) {
            timeVal = typeof item.gap === 'number' && item.gap > 0 ? `+${item.gap.toFixed(3)}s` : String(item.gap);
        } else if (item.interval !== undefined) {
            timeVal = String(item.interval);
        }

        const isMeClass = item.isMe || item.isCurrentPlayer ? 'is-me' : '';

        html += `
            <tr class="${isMeClass}">
                <td class="col-pos ${posClass}">${pos}</td>
                <td class="col-driver" title="${name}">${name}</td>
                <td class="col-lap">${lapVal}</td>
                <td class="col-time">${timeVal}</td>
            </tr>
        `;
    });

    elements.scoreboardBody.innerHTML = html;

    // Dynamically update the track silhouette minimap and player dots
    updateTrackMap(rows);
}

/**
 * Updates the current lap and/or total laps.
 * Called directly by JGVRP FiveM client.
 */
function setLap(...args) {
    console.log('[RaceRoom] setLap:', ...args);
    sendTelemetry('setLap', args);
    hasReceivedLap = true;

    if (!elements.lap) return;

    if (args.length >= 2) {
        const current = args[0];
        const total = args[1];

        if (total === null || total === undefined) {
            // Endurance Mode (Timed race, no fixed total laps)
            setRaceMode('endurance');
            elements.lap.innerText = `LAP ${current}`;
        } else {
            const totalLaps = Number(total);
            elements.lap.innerText = `${current} / ${totalLaps}`;
            if (totalLaps > 1) {
                setRaceMode('circuit');
            } else if (totalLaps === 1) {
                setRaceMode('sprint');
            }
        }
    } else if (args.length === 1) {
        const val = args[0];
        if (typeof val === 'string' && val.includes('/')) {
            elements.lap.innerText = val;
        } else if (typeof val === 'object' && val !== null) {
            const current = val.current ?? val.lap ?? 1;
            const total = val.total ?? val.totalLaps ?? '-';
            elements.lap.innerText = `${current} / ${total}`;
        } else {
            elements.lap.innerText = `LAP ${val}`;
            setRaceMode('endurance');
        }
    }
}

/**
 * Updates current race time / elapsed time / lap time.
 * Called directly by JGVRP FiveM client.
 */
function setTime(...args) {
    console.log('[RaceRoom] setTime:', ...args);
    sendTelemetry('setTime', args);

    if (!elements.time) return;

    if (args.length >= 1) {
        elements.time.innerText = formatTime(args[0]);

        // If time is running but setLap was never called -> SPRINT Mode (1 lap point-to-point)
        if (!hasReceivedLap && elements.lap && (elements.lap.innerText === '- / -' || elements.lap.innerText === '-')) {
            setRaceMode('sprint');
            elements.lap.innerText = 'SPRINT';
        }
    }
}

// Make functions explicitly accessible globally on window
window.updateScoreboard = updateScoreboard;
window.setLap = setLap;
window.setTime = setTime;
window.setRaceMode = setRaceMode;
